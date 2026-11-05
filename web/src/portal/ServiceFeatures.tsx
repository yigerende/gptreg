import { Zap, Mail, HouseWifi } from "lucide-react";
export default function ServiceFeatures({
  compact = false,
}: {
  compact?: boolean;
}) {
  return (
    <div className={`p-service-features ${compact ? "compact" : ""}`}>
      <article>
        <span>
          <Zap size={21} />
        </span>
        <div>
          <b>实时注册</b>
          <p>下单后进入注册队列，进度随时可查。</p>
        </div>
      </article>
      <article>
        <span className="gmail">
          <Mail size={21} />
        </span>
        <div>
          <b>Google Gmail 邮箱</b>
          <p>使用谷歌 Gmail 邮箱完成账号注册。</p>
        </div>
      </article>
      <article>
        <span>
          <HouseWifi size={21} />
        </span>
        <div>
          <b>动态高权重家宽注册</b>
          <p>动态住宅代理网络，家宽环境注册。</p>
        </div>
      </article>
    </div>
  );
}
