import { Context, Session, Logger, Time, Schema } from 'koishi'
import RssFeedEmitter from 'rss-feed-emitter'

declare module 'koishi' {
  interface Channel {
    rss: string[]
  }

  interface Modules {
    rss: typeof import('.')
  }
}

const logger = new Logger('rss')

export const name = 'RSS'
export const inject = ['database'] as const

export interface Config {
  timeout?: number
  refresh?: number
  userAgent?: string
  parserFn?: string
}

export const Config: Schema<Config> = Schema.object({
  timeout: Schema.number().description('请求数据的最长时间。').default(Time.second * 10),
  refresh: Schema.number().description('刷新数据的时间间隔。').default(Time.minute),
  userAgent: Schema.string().description('请求时使用的 User Agent。'),
  parserFn: Schema.string().description('解析数据的函数。')
    .role('textarea')
    .default(
      `const description = payload.description
      .replace(/<aside[^>]*>[\\s\\S]*?<\\/aside>/g, '') // 删除引用内容
      .replace(/<img([^>]*)>/gi, "<img$1 />") // 闭合 <img> 标签
      .replace(/<br([^>]*)>/gi, "<br$1 />"); // 闭合 <br> 标签
      \nreturn \`\${payload.meta.title} (\${payload.author})\n\${payload.title}\n\${payload.link}\n\${description}\``
    ),
})

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('channel', {
    rss: 'list',
  })

  const { timeout, refresh, userAgent, parserFn } = config
  const feedMap: Record<string, Set<string>> = {}
  const feeder = new RssFeedEmitter({ skipFirstLoad: true, userAgent })
  const parser = new Function('payload', parserFn)

  function subscribe(url: string, guildId: string) {
    if (url in feedMap) {
      feedMap[url].add(guildId)
    } else {
      feedMap[url] = new Set([guildId])
      feeder.add({ url, refresh })
      logger.debug('subscribe', url)
    }
  }

  function unsubscribe(url: string, guildId: string) {
    feedMap[url].delete(guildId)
    if (!feedMap[url].size) {
      delete feedMap[url]
      feeder.remove(url)
      logger.debug('unsubscribe', url)
    }
  }

  ctx.on('dispose', () => {
    feeder.destroy()
  })

  feeder.on('error', (err: Error) => {
    logger.debug(err.message)
  })

  feeder.on('new-item', async (payload) => {
    logger.debug('receive', payload.title)
    const source = payload.meta.link
    if (!feedMap[source]) return
    const message = parser(payload)
    await ctx.broadcast([...feedMap[source]], message)
  })

  ctx.on('ready', async () => {
    const channels = await ctx.database.getAssignedChannels(['platform', 'id', 'rss'])
    for (const channel of channels) {
      for (const url of channel.rss) {
        subscribe(url, `${channel.platform}:${channel.id}`)
      }
    }
  })

  const validators: Record<string, Promise<unknown>> = {}
  async function validate(url: string, session: Session) {
    if (validators[url]) {
      await session.send('正在尝试连接……')
      return validators[url]
    }

    let timer: NodeJS.Timeout
    const feeder = new RssFeedEmitter({ userAgent })
    return validators[url] = new Promise((resolve, reject) => {
      // rss-feed-emitter's typings suck
      feeder.add({ url, refresh: 1 << 30 })
      feeder.on('new-item', resolve)
      feeder.on('error', reject)
      timer = setTimeout(() => reject(new Error('connect timeout')), timeout)
    }).finally(() => {
      feeder.destroy()
      clearTimeout(timer)
      delete validators[url]
    })
  }

  ctx.guild()
    .command('rss <url:text>', '订阅 RSS 链接')
    .channelFields(['rss', 'id', 'platform'])
    .option('list', '-l 查看订阅列表')
    .option('remove', '-r 取消订阅')
    .action(async ({ session, options }, url) => {
      const { rss, id, platform } = session.channel

      if (options.list) {
        if (!rss.length) return '未订阅任何链接。'
        return rss.join('\n')
      }

      const index = rss.indexOf(url)

      if (options.remove) {
        if (index < 0) return '未订阅此链接。'
        rss.splice(index, 1)
        unsubscribe(url, `${platform}:${id}`)
        return '取消订阅成功！'
      }

      if (index >= 0) return '已订阅此链接。'
      return validate(url, session).then(() => {
        subscribe(url, `${platform}:${id}`)
        if (!rss.includes(url)) {
          rss.push(url)
          return '添加订阅成功！'
        }
      }, (error) => {
        logger.debug(error)
        return '无法订阅此链接。'
      })
    })
}
