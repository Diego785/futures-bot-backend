import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL } from './apiClient';
import type { Candle } from '../features/candles/candles.types';

export type MarketStatus =
  | 'OFFLINE'
  | 'LIVE'
  | 'STALE'
  | 'RECONNECTING'
  | 'DISCONNECTED';

export interface LiveHandlers {
  onPrice: (symbol: string, price: number) => void;
  onLiveUpdate: (candle: Candle) => void;
  onClosed: (candle: Candle) => void;
  onStatus: (status: MarketStatus) => void;
}

/**
 * Cliente Socket.IO del market data live (namespace /market del backend). Una conexión;
 * el stream activo (symbol, tf) se cambia con setStream (desuscribe el anterior).
 */
export class LiveClient {
  private socket: Socket | null = null;
  private current: { symbol: string; tf: string } | null = null;

  connect(h: LiveHandlers): void {
    if (this.socket) return;
    const socket = io(`${API_BASE_URL}/market`, {
      transports: ['websocket'],
      reconnection: true,
    });
    this.socket = socket;

    socket.on('connect', () => {
      if (this.current) socket.emit('subscribe', this.current);
    });
    socket.on('disconnect', () => h.onStatus('DISCONNECTED'));
    socket.on('price.tick', (d: { symbol: string; price: number }) =>
      h.onPrice(d.symbol, d.price),
    );
    socket.on('candle.live_update', (c: Candle) => h.onLiveUpdate(c));
    socket.on('candle.closed', (c: Candle) => h.onClosed(c));
    socket.on('market.status', (d: { status: MarketStatus }) => h.onStatus(d.status));
  }

  setStream(symbol: string, tf: string): void {
    if (this.current) this.socket?.emit('unsubscribe', this.current);
    this.current = { symbol, tf };
    this.socket?.emit('subscribe', this.current);
  }

  disconnect(): void {
    if (this.current) this.socket?.emit('unsubscribe', this.current);
    this.socket?.disconnect();
    this.socket = null;
    this.current = null;
  }
}
