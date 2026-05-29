// Cliente HTTP mínimo hacia el backend (Market Data API). El backend tiene CORS abierto.
const BASE: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3300';

export const API_BASE_URL = BASE;

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
