import "@testing-library/jest-dom/vitest";
import {it,expect,vi,afterEach} from "vitest";
import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import AdminSuppliers from "./AdminSuppliers";
import * as client from "./client";
let q:QueryClient;afterEach(()=>{cleanup();q?.clear();vi.restoreAllMocks();});
it('switches independent resource views and displays vendor-country rates with the ended denominator',async()=>{
 const calls=vi.spyOn(client,'call').mockImplementation(async path=>{const sms=path.includes('kind=sms');const row={provider:'smsbower',provider_name:'SMSBower',country:'6',country_name:'印度尼西亚',total:4,succeeded:1,failed:2,active:1,unknown:0,success_rate:100/3,receipt_rate:50,receipt_success:1,receipt_known:2,cost_cny:.134,costs:{USD:{confirmed:.02,pending:0,failed_cost:0}}};return {summary:row,items:[row],total:1,coverage:{incomplete_attempts:0},providers:[{id:'smsbower',name:'SMSBower'}],countries:sms?[{id:'6',name:'印度尼西亚'}]:[]};});
 q=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={q}><AdminSuppliers/></QueryClientProvider>);
 await screen.findByText('SMSBower',{selector:'b'});expect(calls.mock.calls[0][0]).toContain('kind=mail');expect(screen.getAllByText('33.3%').length).toBe(2);expect(screen.queryByLabelText('短信国家')).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:/短信厂商与国家/}));await screen.findByLabelText('短信国家');await screen.findByText('印度尼西亚',{selector:'b'});expect(screen.getByText('1 成功 / 3 已结束')).toBeVisible();
 fireEvent.change(screen.getByLabelText('供应商'),{target:{value:'smsbower'}});fireEvent.change(screen.getByLabelText('短信国家'),{target:{value:'6'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));await waitFor(()=>expect(calls.mock.calls.at(-1)?.[0]).toContain('country=6'));
});
