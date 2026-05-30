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

// POST/PATCH/DELETE con cuerpo JSON opcional. Lanza si la respuesta no es 2xx para que el
// caller pueda degradar a modo local (sin persistencia) sin romper la UI.
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${method} ${path}: ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
