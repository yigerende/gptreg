"use strict";
const { createHash } = require("node:crypto");
const { receivedMailCode } = require("../mail-cost-ledger");
const { isTerminalJobStatus } = require("../job-lifecycle");
const PROVIDERS = { smsbower: "SMSBower", "hero-sms": "Hero-SMS", firefox: "Firefox", xiaopingguo: "小苹果", mailcom: "Mail.com", fastmail: "Fastmail", icloud: "iCloud", mock: "模拟供应商", unknown: "未记录厂商" };
function providerId(value) {
  const p = String(value || "").trim().toLowerCase();
  return ({ "sms-bower":"smsbower", smsbower_mail:"smsbower", "firefox-fun":"firefox", "firefox.fun":"firefox" })[p]
    || (/^[a-z0-9][a-z0-9_.-]{0,40}$/.test(p) ? p : "unknown");
}
const safeName = value => typeof value === "string" ? value.trim().replace(/[\x00-\x1f<>]/g, "").slice(0,80) : "";
const idOf = value => String(value && typeof value === "object" ? value.id ?? value.country ?? value.code ?? "" : value ?? "");
function countryFact(raw, state, provider) {
  const id = idOf(raw.country ?? raw.countryId);
  const country = /^[a-zA-Z0-9_-]{1,24}$/.test(id) ? id : "unknown";
  const preflight = state.preflight?.sms;
  const options = providerId(preflight?.provider) === provider
    ? [preflight?.country, ...(preflight?.countries || []).map(c => c.country || c)] : [];
  const match = options.find(c => idOf(c) === country);
  const catalog = provider === "smsbower" ? require("../sms-provider").SMSBOWER_COUNTRY_CATALOG.find(c => String(c.id) === country) : null;
  let name = safeName(raw.countryName || match?.chn || match?.name || match?.eng || catalog?.name);
  const names={Chile:"智利",Indonesia:"印度尼西亚",Germany:"德国",Philippines:"菲律宾",Brazil:"巴西",Colombia:"哥伦比亚",Ukraine:"乌克兰","Saudi Arabia":"沙特阿拉伯",Peru:"秘鲁",Vietnam:"越南",USA:"美国",Malaysia:"马来西亚",Japan:"日本"};
  name=names[name] || name;
  return { country, country_name: country === "unknown" ? "未记录国家" : name || (/^[A-Z]{2}$/.test(country) ? country : `国家 ${country}`) };
}
function supplierRecords(state, resources, smsLedgers) {
  const terminal = ["complete","partial","failed","cancelled"].includes(state.status);
  const mail = (state.mailboxes || []).map((m,index) => {
    const provider = providerId(m.provider || state.runPlan?.mailProvider || state.preflight?.mail?.provider);
    const jobs = (state.jobs || []).filter(j => m.id != null && String(j.mailboxId) === String(m.id));
    const cost = resources.mail.find(r => r.key === createHash("sha256").update(JSON.stringify(["mail",m.provider || state.runPlan?.mailProvider || "mail",m.id || [state.runId,index]])).digest("hex"));
    const succeeded = jobs.some(j => j.status === "complete");
    const outcome = cost?.outcome || (succeeded ? "succeeded" : jobs.some(j => !isTerminalJobStatus(j.status)) && !terminal ? "active"
      : jobs.length && (terminal || jobs.every(j => isTerminalJobStatus(j.status))) ? "failed" : "unknown");
    const received = receivedMailCode(m,state) || succeeded ? true
      : m.rentalClosed === "cancelled" || m.codeReceived === false ? false : null;
    return { ...(cost || {key:createHash("sha256").update(JSON.stringify(["supplier-mail",provider,m.id || [state.runId,index]])).digest("hex"),currency:"USD",confirmed:0,pending:0,refunded:0,price_unknown:true}),
      provider,outcome,received,country:"",country_name:"",counted:true };
  });
  // The ordering matches resourceRecords; neither activation IDs nor numbers leave the checkpoint.
  let index=0;
  const sms = smsLedgers.flatMap(({ledger}) => ledger.records.map(r => {
    const raw=r.record || {},provider=providerId(raw.provider || raw.providerName || state.preflight?.sms?.provider);
    const fact=resources.sms[index++];
    const received = raw.codeReceived === true || raw.targetAccepted === true || ["code_received","received"].includes(r.status) ? true
      : fact.outcome === "succeeded" ? true : r.cancelled && !r.consumed ? false : null;
    return {...fact,provider,...countryFact(raw,state,provider),received};
  }));
  return {mail,sms};
}
module.exports={PROVIDERS,providerId,countryFact,supplierRecords};
