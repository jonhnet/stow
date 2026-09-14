import * as Y from 'yjs';
import { isEmptyUpdate } from './yjs-updates';

interface Hello {
  type: 'hello';
  from: string;
  vector: Uint8Array;
  to?: string;
  reply?: true;
}

/** Two-way state-vector exchange; ordinary edits retain their binary wire format. */
export class TabSync {
  private readonly id = crypto.randomUUID();

  constructor(private readonly doc: Y.Doc, private readonly post: (message: Hello | Uint8Array) => void) {}

  hello(): Hello {
    return { type: 'hello', from: this.id, vector: Y.encodeStateVector(this.doc) };
  }

  receive(message: unknown) {
    if (message instanceof Uint8Array || message instanceof ArrayBuffer) {
      Y.applyUpdate(this.doc, message instanceof Uint8Array ? message : new Uint8Array(message), 'broadcast');
      return;
    }
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'hello') return;
    // Tabs already open on the previous build send a bare hello and understand
    // binary updates. Keep that exchange working across a development reload.
    if (!('vector' in message)) {
      this.sendDifference();
      return;
    }
    if (!(message.vector instanceof Uint8Array) || !('from' in message) || typeof message.from !== 'string') {
      throw new Error('Invalid tab state vector.');
    }
    if (message.from === this.id || ('to' in message && message.to !== this.id)) return;
    this.sendDifference(message.vector);
    // Ask for the other direction, too: a newly opened tab can have edits that
    // this tab has not seen. A reply never elicits another hello.
    if (!('reply' in message && message.reply === true)) {
      this.post({ ...this.hello(), to: message.from, reply: true });
    }
  }

  private sendDifference(vector?: Uint8Array) {
    const update = Y.encodeStateAsUpdate(this.doc, vector);
    if (!isEmptyUpdate(update)) this.post(update);
  }
}
