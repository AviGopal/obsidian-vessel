/**
 * Concept Bus Listener
 *
 * WebSocket client subscribing to activity-api's `/ws` event bus.
 * Listens for concept lifecycle events:
 *   - `concept.created` { concept_id }
 *   - `concept.linked`  { from_concept_id, to_concept_id }
 *   - `concept.usage`   { concept_id }
 *
 * On each event we fetch the affected concept(s) and re-materialize
 * the notes via the existing ConceptSyncService.
 *
 * Handshake matches the existing realtime-sync.ts pattern:
 *   1. open ws://<activity-api>/ws
 *   2. send `{type:"authenticate", token: apiKey}`
 *   3. optionally `{type:"catchup", lastSeenSequence: n}`
 *
 * Reconnection: exponential backoff 1s → 30s.
 */

import type { MetabobVesselSettings } from '../settings';
import type { ConceptDbClient } from '../concept-db-client';
import type { ConceptSyncService } from './concept-sync';

interface ConceptEvent {
  type: string;
  data?: {
    concept_id?: string;
    from_concept_id?: string;
    to_concept_id?: string;
  };
}

const CONCEPT_EVENT_TYPES = new Set<string>([
  'concept.created',
  'concept.linked',
  'concept.usage',
]);

export class ConceptBusListener {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(
    private settings: MetabobVesselSettings,
    private sync: ConceptSyncService,
    private client: ConceptDbClient,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnect');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private buildWsUrl(): string {
    let endpoint = this.settings.websocketUrl || this.settings.activityApiUrl;
    endpoint = endpoint.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    endpoint = endpoint.replace(/\/$/, '');
    if (!endpoint.endsWith('/ws')) endpoint = `${endpoint}/ws`;
    return endpoint;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.buildWsUrl();
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.warn('[ConceptBusListener] failed to open WS', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      const apiKey = this.settings.apiKey;
      if (apiKey && this.ws) {
        try {
          this.ws.send(JSON.stringify({ type: 'authenticate', token: apiKey }));
        } catch (err) {
          console.warn('[ConceptBusListener] authenticate send failed', err);
        }
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        this.handleEvent(msg);
      } catch {
        /* ignore non-JSON */
      }
    };

    this.ws.onerror = (err) => {
      console.warn('[ConceptBusListener] ws error', err);
    };

    this.ws.onclose = (event) => {
      this.ws = null;
      if (this.stopped) return;
      if (event.code === 1000) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleEvent(msg: ConceptEvent): void {
    if (!msg || typeof msg.type !== 'string') return;
    if (!CONCEPT_EVENT_TYPES.has(msg.type)) return;
    const data = msg.data || {};
    const ids: string[] = [];
    if (data.concept_id) ids.push(String(data.concept_id));
    if (data.from_concept_id) ids.push(String(data.from_concept_id));
    if (data.to_concept_id) ids.push(String(data.to_concept_id));
    for (const id of ids) {
      void this.refreshOne(id).catch((err) =>
        console.warn('[ConceptBusListener] refresh failed', { id, err: String(err) }),
      );
    }
  }

  private async refreshOne(id: string): Promise<void> {
    const concept = await this.client.getConcept(id);
    if (!concept) return;
    await this.sync.materializeConcept(concept);
  }
}
