import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrderDetail } from './Workspace';

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

it.each(['queued', 'running', 'review'])('customer %s orders have no cancellation action', async status => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: 'order', status, quantity: 100, delivered: 1, items: [] })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><OrderDetail id="order" onClose={() => {}} /></QueryClientProvider>);
  await screen.findByText('order');
  expect(screen.queryByRole('button', { name: /取消未执行|已请求取消/ })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/cancel'))).toBe(true);
});
