import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Tooltip } from 'radix-ui';
import ProxyInventory from './ProxyInventory';
const clients: QueryClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());vi.restoreAllMocks()});
function mount(){const c=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(c);render(<QueryClientProvider client={c}><Tooltip.Provider><ProxyInventory/></Tooltip.Provider></QueryClientProvider>)}
it('loads actual pages, submits filters and tests selected proxies with visible progress',async()=>{
  let job: any=null;
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const url=new URL(String(input),'http://local');
    if(init?.method==='POST'){job={id:'job',status:'running',done:0,total:1,succeeded:0,failed:0};return new Response(JSON.stringify(job))}
    const offset=Number(url.searchParams.get('offset')||0);
    return new Response(JSON.stringify({items:[{id:'p'+offset,scope:'country',countryCode:'JP',provider:'711proxy',providerLabel:'711Proxy',sourceId:'s1',protocol:'http',endpoint:`http://proxy${offset}.test:8080`,sessionMinutes:10,pulledAt:'',check:null}],total:120,offset,limit:50,countries:['JP'],providers:[{value:'711proxy',label:'711Proxy'}],summary:{total:120,matched:120,healthy:0,failed:0,unknown:120},test:job}));
  });
  mount();await screen.findByText('http://proxy0.test:8080');
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('http://proxy50.test:8080');
  fireEvent.change(screen.getByLabelText('搜索代理'),{target:{value:'8080'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(([u])=>String(u).includes('q=8080')&&String(u).includes('offset=0'))).toBe(true));
  await screen.findByText('http://proxy0.test:8080');fireEvent.click(screen.getByLabelText('选择本页代理'));fireEvent.click(screen.getByRole('button',{name:'测试已选'}));
  await screen.findByRole('progressbar',{name:'代理测试进度'});
  expect(screen.getByRole('button',{name:'测试已选'})).toBeDisabled();
  const post=fetcher.mock.calls.find(([,i])=>i?.method==='POST')!;
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({ids:['p0'],filters:{q:'8080'}});
});

it('shows last use and cooldown deadlines, defaults to recent use and filters only free cooling entries', async () => {
  const lastUsedAt = '2026-11-07T01:00:00.000Z', cooldownUntil = '2026-11-07T01:10:00.000Z';
  const rows = ['busy', 'cold', 'new'].map(id => ({ id, scope: 'country', countryCode: 'JP', provider: '711proxy', providerLabel: '711Proxy', sourceId: 's1', protocol: 'http', endpoint: `http://${id}.test:8080`, sessionMinutes: 10, pulledAt: '', check: null, lastUsedAt: id === 'new' ? '' : lastUsedAt, cooldownUntil: id === 'new' ? '' : cooldownUntil, cooling: id !== 'new', inUse: id === 'busy' }));
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const query = new URL(String(input), 'http://local').searchParams;
    const items = query.get('usage') === 'cooling' ? rows.filter(row => row.cooling && !row.inUse) : rows;
    return new Response(JSON.stringify({ items, total: items.length, offset: 0, limit: 50, countries: ['JP'], providers: [], summary: { total: 3, matched: items.length, inUse: 1, cooling: 1 }, test: null }));
  });
  mount(); await screen.findByText(rows[0].endpoint);
  expect(new URL(String(fetcher.mock.calls[0][0]), 'http://local').searchParams.get('sort')).toBe('used');
  expect(screen.getByRole('columnheader', { name: '最近使用时间 ↓' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '冷却释放时间' })).toBeInTheDocument();
  const busy = within(screen.getByText(rows[0].endpoint).closest('tr')!);
  expect(busy.getByText('使用中，释放后计算')).toBeInTheDocument();
  expect(busy.getByText('占用期间不可分配')).toBeInTheDocument();
  const cold = within(screen.getByText(rows[1].endpoint).closest('tr')!);
  expect(cold.getByText(new Date(lastUsedAt).toLocaleString('zh-CN', { hour12: false }))).toBeInTheDocument();
  expect(cold.getByText(new Date(cooldownUntil).toLocaleString('zh-CN', { hour12: false }))).toBeInTheDocument();
  expect(screen.getByText('未记录')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', { name: '筛选使用状态' }));
  fireEvent.click(screen.getByRole('option', { name: '冷却中（未占用）' }));
  await waitFor(() => expect(screen.queryByText(rows[0].endpoint)).not.toBeInTheDocument());
  expect(await screen.findByText(rows[1].endpoint)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('combobox', { name: '代理排序' }));
  fireEvent.click(screen.getByRole('option', { name: '按国家排序' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('sort=country'))).toBe(true));
  expect(screen.getByRole('columnheader', { name: '最近使用时间' })).toBeInTheDocument();
});
