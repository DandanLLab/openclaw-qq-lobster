import type { PluginContext, PluginResult } from './index.js';

interface MemberInfo {
  user_id: number;
  nickname: string;
  card: string;
}

interface HistoryMessage {
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
  };
  raw_message: string;
  message_id?: string;
}

export class PokeEnhancer {
  private napcatHost: string = '127.0.0.1';
  private napcatPort: string = '3000';
  private token: string = '';
  private reactionProbability: number = 0.3;
  private debug: boolean = false;

  async initialize(config: any): Promise<void> {
    this.napcatHost = config.napcatHost || '127.0.0.1';
    this.napcatPort = String(config.napcatPort || '3000');
    this.token = config.napcatToken || '';
    this.reactionProbability = config.pokeReactionProbability ?? 0.3;
    this.debug = config.pokeDebug ?? false;
    console.log('[PokeEnhancer] 初始化完成');
  }

  async handle(ctx: PluginContext): Promise<PluginResult> {
    const { text, groupId, client, isGroup } = ctx;

    if (!isGroup || !groupId) {
      return { handled: false };
    }

    const match = text.match(/戳(.*)/);
    if (!match) {
      return { handled: false };
    }

    const targetKeyword = match[1].trim();
    if (!targetKeyword) {
      return { handled: false, response: '你想戳谁？请说清楚一点～' };
    }

    try {
      const targetUserId = await this.findUserByMessageContent(
        targetKeyword,
        groupId,
        client
      );

      if (!targetUserId) {
        return { handled: false, response: `没找到「${targetKeyword}」相关的人呢～` };
      }

      const selfId = client.getSelfId?.();
      if (selfId && String(targetUserId) === String(selfId)) {
        return { handled: false, response: '戳自己？咱才不会做这种傻事呢！' };
      }

      const success = await this.sendPoke(groupId, targetUserId, client);
      if (success) {
        return { handled: true, response: `已戳 ${targetKeyword}～` };
      } else {
        return { handled: false, response: '戳失败了，可能是对方隐身了～' };
      }
    } catch (e) {
      console.error('[PokeEnhancer] 戳一戳失败:', e);
      return { handled: false, error: String(e) };
    }
  }

  async findUserByMessageContent(
    keyword: string,
    groupId: number,
    client: any
  ): Promise<number | null> {
    try {
      const history = await client.getGroupMsgHistory?.(groupId);
      if (history?.messages) {
        for (const msg of history.messages.slice(-20)) {
          const rawMessage = msg.raw_message || '';
          const sender = msg.sender || {};
          
          if (rawMessage.includes(keyword)) {
            return sender.user_id;
          }
          
          const nickname = sender.nickname || '';
          const card = sender.card || '';
          if (nickname.includes(keyword) || card.includes(keyword)) {
            return sender.user_id;
          }
        }
      }

      const members = await client.getGroupMemberList?.(groupId);
      if (members && Array.isArray(members)) {
        for (const member of members) {
          const nickname = member.nickname || member.user_name || '';
          const card = member.card || '';
          if (nickname.includes(keyword) || card.includes(keyword)) {
            return member.user_id;
          }
        }
      }

      return null;
    } catch (e) {
      console.error('[PokeEnhancer] 查找用户失败:', e);
      return null;
    }
  }

  async sendPoke(groupId: number, userId: number, client: any): Promise<boolean> {
    try {
      if (client.sendGroupPoke) {
        await client.sendGroupPoke(groupId, userId);
        return true;
      }

      const http = await import('http');
      return new Promise((resolve) => {
        const postData = JSON.stringify({
          group_id: groupId,
          user_id: userId
        });

        const options = {
          hostname: this.napcatHost,
          port: parseInt(this.napcatPort),
          path: '/send_poke',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            ...(this.token ? { 'Authorization': this.token } : {})
          }
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              resolve(result.status === 'ok');
            } catch {
              resolve(false);
            }
          });
        });

        req.on('error', (e) => {
          console.error('[PokeEnhancer] 发送戳一戳失败:', e);
          resolve(false);
        });

        req.write(postData);
        req.end();
      });
    } catch (e) {
      console.error('[PokeEnhancer] 发送戳一戳异常:', e);
      return false;
    }
  }

  async handlePokeEvent(
    pokerId: number,
    targetId: number,
    groupId: number | undefined,
    client: any
  ): Promise<{ shouldReact: boolean; response?: string }> {
    const selfId = client.getSelfId?.();
    if (String(targetId) !== String(selfId)) {
      return { shouldReact: false };
    }

    if (Math.random() < this.reactionProbability && groupId) {
      await this.sendPoke(groupId, pokerId, client);
    }

    const responses = [
      '哼，戳什么戳！再戳就把你禁言了！',
      '戳戳戳，戳你个大头鬼！',
      '干嘛戳我啦～笨蛋！',
      '你再戳一下试试？试试就试试！',
      '戳我干嘛，有话直说！',
      '哼，本座被你戳醒了，有什么事快说！',
      '戳一戳成就达成！你已获得『戳神』称号～',
      '别戳了别戳了，咱在呢！',
    ];

    return {
      shouldReact: true,
      response: responses[Math.floor(Math.random() * responses.length)]
    };
  }
}
