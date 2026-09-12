import Image from "next/image";
import { ArrowRight, ArrowUp, ExternalLink } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Reveal } from "@/components/reveal";
import { CopyWechatButton } from "@/components/copy-wechat-button";
import { CurrentYear } from "@/components/current-year";
import { aboutPrinciples, brand, contentDirections } from "@/lib/brand";

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="top">
        <section
          className="mx-auto grid min-h-[min(760px,calc(100svh_-_var(--header-height)))] w-[min(1200px,calc(100%_-_48px))] grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)] items-center gap-[clamp(36px,6vw,88px)] py-[clamp(52px,6vw,78px)] max-[899px]:w-[min(calc(100%_-_40px),720px)] max-[899px]:grid-cols-2 max-[899px]:gap-9 max-sm:min-h-0 max-sm:w-[calc(100%_-_40px)] max-sm:grid-cols-1 max-sm:gap-10.5 max-sm:pt-13.5 max-sm:pb-18"
          aria-labelledby="hero-title"
        >
          <Reveal className="relative z-10">
            <h1
              className="mb-7 max-w-[8ch] text-[clamp(58px,6.5vw,94px)] leading-[1.04] font-extrabold tracking-[-0.06em] max-sm:mb-5.5 max-sm:max-w-[7ch] max-sm:text-[clamp(52px,16vw,67px)]"
              id="hero-title"
            >
              向前，自有风景。
            </h1>
            <p className="mb-6 max-w-124 text-lg leading-[1.8] text-ink-soft max-sm:text-[17px]">
              林昂在路上，记录成长的过程，也发现日常的风景。每一次探索，都让我们离更好的自己近一点。
            </p>
            <p className="mb-8 text-[13px] font-[750] tracking-[0.3em]">{brand.slogan}</p>
            <div className="flex flex-wrap gap-3.5 max-sm:grid max-sm:grid-cols-1">
              <a
                className="inline-flex min-h-12.5 cursor-pointer items-center justify-center gap-2.5 rounded-xs border border-transparent bg-brand-orange px-5.5 py-3 font-[750] leading-[1.2] text-brand-navy transition-[transform,background-color,color] duration-180 hover:-translate-y-0.5 hover:bg-[#ff9a58] motion-reduce:hover:translate-y-0 max-sm:w-full [&_svg]:size-4.5 [&_svg]:stroke-2"
                href="#content"
              >
                开始探索 <ArrowRight aria-hidden="true" />
              </a>
              <a
                className="inline-flex min-h-12.5 cursor-pointer items-center justify-center gap-2.5 rounded-xs border border-ink bg-transparent px-5.5 py-3 font-[750] leading-[1.2] transition-[transform,background-color,color] duration-180 hover:-translate-y-0.5 hover:bg-ink hover:text-page motion-reduce:hover:translate-y-0 max-sm:w-full [&_svg]:size-4.5 [&_svg]:stroke-2"
                href="#about"
              >
                认识 linonward
              </a>
            </div>
          </Reveal>
          <Reveal className="relative min-h-[min(58vh,590px)] overflow-hidden bg-visual max-[899px]:min-h-125 max-sm:aspect-3/4 max-sm:min-h-0">
            <Image
              className="origin-right object-cover object-right min-[900px]:scale-120"
              src={brand.assets.hero}
              alt="深蓝群山、蜿蜒道路与橙色太阳组成的 linonward 主视觉"
              fill
              fetchPriority="high"
              sizes="(max-width: 767px) calc(100vw - 40px), (max-width: 1199px) 48vw, 620px"
            />
          </Reveal>
        </section>

        <section
          id="about"
          className="border-y border-line bg-surface py-[clamp(92px,10vw,148px)] max-sm:py-20.5"
          aria-labelledby="about-title"
        >
          <div className="mx-auto w-[min(1200px,calc(100%_-_48px))] max-[899px]:w-[min(calc(100%_-_40px),720px)] max-sm:w-[calc(100%_-_40px)]">
            <Reveal className="max-w-190">
              <p className="mb-6.5 text-xs font-extrabold tracking-[0.26em] before:mr-3.5 before:inline-block before:h-px before:w-9 before:align-middle before:bg-current before:content-['']">
                ABOUT LINONWARD
              </p>
              <h2
                className="mb-7 text-[clamp(42px,5vw,70px)] leading-[1.15] font-extrabold tracking-[-0.045em] max-sm:text-[clamp(40px,12vw,52px)]"
                id="about-title"
              >
                每一步，都算数。
              </h2>
              <p className="mb-0 max-w-170 text-lg text-ink-soft max-sm:text-[17px]">
                不必等到一切准备好，才开始走向新的方向。linonward
                以「在路上」为起点，记录尝试、思考与改变，让成长发生在具体的每一天。
              </p>
            </Reveal>
            <div className="mt-19 grid grid-cols-3 border-y border-line max-sm:mt-13 max-sm:grid-cols-1">
              {aboutPrinciples.map((item) => (
                <Reveal
                  className="min-h-49 border-l border-line py-8 pr-8.5 pl-8.5 first:border-l-0 first:pl-0 max-sm:min-h-0 max-sm:border-t max-sm:border-l-0 max-sm:px-0 max-sm:py-6.5 max-sm:first:border-t-0"
                  key={item.title}
                >
                  <h3 className="mb-3.5 text-[31px] leading-[1.2] font-bold">{item.title}</h3>
                  <p className="mb-0 max-w-60 text-muted">{item.description}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section
          id="content"
          className="relative overflow-hidden py-[clamp(92px,10vw,148px)] max-sm:py-20.5"
          aria-labelledby="content-title"
        >
          <span
            className="pointer-events-none absolute top-13 -right-[8vw] z-0 aspect-square w-[min(32vw,430px)] rounded-full bg-brand-orange opacity-96 max-sm:top-23.5 max-sm:-right-24 max-sm:w-45"
            aria-hidden="true"
          />
          <div className="relative z-10 mx-auto grid w-[min(1200px,calc(100%_-_48px))] grid-cols-[minmax(280px,0.76fr)_minmax(480px,1.24fr)] items-start gap-[clamp(64px,10vw,148px)] max-[899px]:w-[min(calc(100%_-_40px),720px)] max-[899px]:grid-cols-1 max-sm:w-[calc(100%_-_40px)]">
            <Reveal className="sticky top-[calc(var(--header-height)_+_52px)] max-[899px]:static">
              <p className="mb-6.5 text-xs font-extrabold tracking-[0.26em] before:mr-3.5 before:inline-block before:h-px before:w-9 before:align-middle before:bg-current before:content-['']">
                CONTENT DIRECTION
              </p>
              <h2
                className="mb-7 text-[clamp(42px,5vw,70px)] leading-[1.15] font-extrabold tracking-[-0.045em] max-sm:text-[clamp(40px,12vw,52px)]"
                id="content-title"
              >
                把日常，
                <br />
                走成风景。
              </h2>
              <p className="mb-8.5 max-w-100 text-[17px] text-ink-soft">
                从成长、记录和探索出发，分享那些值得停下来思考的瞬间。
              </p>
              <a
                className="inline-flex min-h-12.5 cursor-pointer items-center justify-center gap-2.5 rounded-xs border border-transparent bg-brand-orange px-5.5 py-3 font-[750] leading-[1.2] text-brand-navy transition-[transform,background-color,color] duration-180 hover:-translate-y-0.5 hover:bg-[#ff9a58] motion-reduce:hover:translate-y-0 max-sm:w-full [&_svg]:size-4.5 [&_svg]:stroke-2"
                href="#follow"
              >
                关注后续内容 <ArrowRight aria-hidden="true" />
              </a>
            </Reveal>
            <div className="border-t border-ink">
              {contentDirections.map((item) => (
                <Reveal
                  className="grid grid-cols-[86px_1fr] gap-5 border-b border-ink py-8.5 max-sm:grid-cols-[58px_1fr] max-sm:gap-3 max-sm:py-7"
                  key={item.number}
                >
                  <span
                    className="text-[26px] font-[350] tracking-[0.08em] max-sm:text-[21px]"
                    aria-hidden="true"
                  >
                    {item.number}
                  </span>
                  <div>
                    <h3 className="mb-2 text-[27px] leading-[1.2] font-bold max-sm:text-2xl">
                      {item.title}
                    </h3>
                    <p className="mb-0 text-[17px] text-muted max-sm:text-base">
                      {item.description}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section
          id="products"
          className="border-y border-line bg-surface py-[clamp(92px,10vw,148px)] max-sm:py-20.5"
          aria-labelledby="products-title"
        >
          <div className="mx-auto grid w-[min(1200px,calc(100%_-_48px))] grid-cols-[minmax(280px,0.82fr)_minmax(460px,1.18fr)] items-center gap-[clamp(64px,9vw,128px)] max-[899px]:w-[min(calc(100%_-_40px),720px)] max-[899px]:grid-cols-1 max-sm:w-[calc(100%_-_40px)]">
            <Reveal className="max-[899px]:max-w-160">
              <p className="mb-6.5 text-xs font-extrabold tracking-[0.26em] before:mr-3.5 before:inline-block before:h-px before:w-9 before:align-middle before:bg-current before:content-['']">
                PRODUCT / 01
              </p>
              <h2
                className="mb-7 max-w-[9ch] text-[clamp(42px,5vw,70px)] leading-[1.15] font-extrabold tracking-[-0.045em] max-sm:text-[clamp(40px,12vw,52px)]"
                id="products-title"
              >
                第一个产品，
                <br />
                已经在路上。
              </h2>
              <p className="mb-8.5 max-w-120 text-lg text-ink-soft max-sm:text-[17px]">
                <strong className="mb-3 block text-[23px] leading-[1.3] text-ink">
                  {brand.product.name}
                </strong>
                {brand.product.description}
              </p>
              <a
                className="inline-flex min-h-12.5 cursor-pointer items-center justify-center gap-2.5 rounded-xs border border-transparent bg-brand-orange px-5.5 py-3 font-[750] leading-[1.2] text-brand-navy transition-[transform,background-color,color] duration-180 hover:-translate-y-0.5 hover:bg-[#ff9a58] motion-reduce:hover:translate-y-0 max-sm:w-full [&_svg]:size-4.5 [&_svg]:stroke-2"
                href={brand.product.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                了解 Interview Pack <ExternalLink aria-hidden="true" />
              </a>
            </Reveal>

            <Reveal className="relative border border-panel bg-panel p-[clamp(30px,4vw,54px)] text-on-panel shadow-[18px_18px_0_var(--orange)] max-sm:px-6 max-sm:py-7 max-sm:shadow-[10px_10px_0_var(--orange)]">
              <div className="flex items-baseline justify-between gap-6 border-b border-panel-line pb-5.5 max-sm:flex-col max-sm:items-start max-sm:gap-2">
                <strong className="text-[clamp(25px,3vw,38px)] leading-none tracking-[-0.04em]">
                  {brand.product.name}
                </strong>
                <span className="text-xs tracking-[0.12em] text-on-panel-soft">by linonward</span>
              </div>
              <p className="mt-8.5 mb-3 text-xs font-extrabold tracking-[0.2em] text-brand-orange">
                {brand.product.audience}
              </p>
              <h3 className="mb-4.5 text-[clamp(30px,3.6vw,48px)] leading-[1.18] font-bold tracking-[-0.04em] max-sm:text-[clamp(30px,9vw,38px)]">
                <span className="block">针对这一场面试，</span>
                <span className="block">做更有针对性的准备。</span>
              </h3>
              <p className="mb-7.5 text-sm tracking-[0.08em] text-on-panel-soft">
                {brand.product.inputs}
              </p>
              <ol className="m-0 list-none border-t border-panel-line p-0">
                {brand.product.features.map((feature, index) => (
                  <li
                    className="grid grid-cols-[42px_1fr] items-baseline gap-4 border-b border-panel-line py-4.25 max-sm:grid-cols-[34px_1fr] max-sm:gap-2.5"
                    key={feature}
                  >
                    <span
                      className="text-[13px] tracking-[0.08em] text-brand-orange"
                      aria-hidden="true"
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <strong className="text-[17px]">{feature}</strong>
                  </li>
                ))}
              </ol>
              <a
                className="mt-7 inline-flex w-fit items-center gap-3 border-b border-brand-orange text-sm font-[750] text-brand-orange [&_svg]:size-4.25"
                href={brand.product.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                interview.linonward.com <ArrowRight aria-hidden="true" />
              </a>
            </Reveal>
          </div>
        </section>

        <section
          id="brand"
          className="overflow-hidden bg-panel text-on-panel"
          aria-labelledby="brand-title"
        >
          <div className="mx-auto grid w-[min(1200px,calc(100%_-_48px))] grid-cols-[minmax(280px,0.7fr)_minmax(0,1.3fr)] items-center gap-[clamp(48px,8vw,112px)] py-[clamp(92px,10vw,148px)] max-[899px]:w-[min(calc(100%_-_40px),720px)] max-[899px]:grid-cols-1 max-sm:w-[calc(100%_-_40px)] max-sm:py-20.5">
            <Reveal className="max-[899px]:max-w-160">
              <p className="mb-6.5 text-xs font-extrabold tracking-[0.26em] text-on-panel-soft before:mr-3.5 before:inline-block before:h-px before:w-9 before:align-middle before:bg-current before:content-['']">
                BRAND MATERIALS
              </p>
              <h2
                id="brand-title"
                className="mb-7 text-[clamp(42px,4.2vw,54px)] leading-[1.15] font-extrabold tracking-[-0.045em] max-sm:text-[clamp(36px,10.5vw,44px)]"
              >
                <span className="block whitespace-nowrap">让「在路上」，</span>
                <span className="block">
                  <span className="block whitespace-nowrap max-[899px]:inline max-sm:block">
                    成为日常的
                  </span>
                  <span className="block whitespace-nowrap max-[899px]:inline max-sm:block">
                    一部分。
                  </span>
                </span>
              </h2>
              <p className="mb-0 max-w-112 text-lg text-on-panel-soft">
                从一枚标识，到随身携带的物件，让每次出发都有熟悉的陪伴。
              </p>
            </Reveal>
            <Reveal className="grid grid-cols-[minmax(0,1fr)_28%] items-end gap-5 max-sm:grid-cols-[1fr_36%] max-sm:gap-3">
              <figure className="m-0">
                <Image
                  className="block h-auto w-full"
                  src={brand.assets.merch}
                  alt="印有 linonward 标识的帆布袋、水壶、笔记本与贴纸概念效果图"
                  width={1536}
                  height={1024}
                  sizes="(max-width: 899px) calc(100vw - 40px), 620px"
                />
                <figcaption className="pt-4 text-[13px] tracking-[0.14em] text-on-panel-soft max-sm:max-w-56 max-sm:tracking-[0.08em]">
                  品牌周边概念展示
                </figcaption>
              </figure>
              <figure className="m-0 translate-y-9.5 max-sm:translate-y-5">
                <Image
                  className="block h-auto w-full"
                  src={brand.assets.poster}
                  alt="linonward 向前走主题品牌海报"
                  width={1024}
                  height={1536}
                  sizes="(max-width: 899px) 36vw, 220px"
                />
              </figure>
            </Reveal>
          </div>
        </section>

        <section
          id="follow"
          className="relative overflow-hidden border-t border-panel-line bg-panel-alt py-[clamp(92px,10vw,148px)] text-on-panel max-sm:py-20.5"
          aria-labelledby="follow-title"
        >
          <span
            className="pointer-events-none absolute right-[8vw] -bottom-40 z-0 size-65 rounded-full bg-brand-orange"
            aria-hidden="true"
          />
          <div className="relative z-10 mx-auto grid w-[min(1200px,calc(100%_-_48px))] grid-cols-[0.9fr_1.1fr] items-center gap-[clamp(56px,9vw,120px)] max-[899px]:w-[min(calc(100%_-_40px),720px)] max-[899px]:grid-cols-1 max-sm:w-[calc(100%_-_40px)]">
            <Reveal>
              <p className="mb-6.5 text-xs font-extrabold tracking-[0.26em] text-on-panel-soft before:mr-3.5 before:inline-block before:h-px before:w-9 before:align-middle before:bg-current before:content-['']">
                FOLLOW LINONWARD
              </p>
              <h2
                id="follow-title"
                className="mb-7 text-[clamp(42px,5vw,70px)] leading-[1.15] font-extrabold tracking-[-0.045em] max-sm:text-[clamp(40px,12vw,52px)]"
              >
                下一段路，
                <br />
                一起走。
              </h2>
              <p className="mb-0 max-w-120 text-lg text-on-panel-soft">
                关注「林昂在路上」，继续发现日常里的成长与风景。
              </p>
            </Reveal>
            <Reveal className="grid grid-cols-[minmax(180px,220px)_minmax(0,1fr)] items-center gap-8.5 max-sm:grid-cols-1 max-sm:items-start max-sm:gap-7">
              {brand.wechatQrCode ? (
                <figure className="m-0 w-full bg-white px-3 pt-3 pb-2.5 text-brand-navy max-sm:w-[min(220px,100%)]">
                  <Image
                    className="block aspect-square h-auto w-full"
                    src={brand.wechatQrCode}
                    alt="林昂在路上微信公众号二维码"
                    width={258}
                    height={258}
                    sizes="220px"
                    unoptimized
                  />
                  <figcaption className="pt-2.25 text-center text-xs leading-[1.45] font-bold">
                    微信扫码关注「林昂在路上」
                  </figcaption>
                </figure>
              ) : (
                <Image
                  className="size-38.5 border-3 border-on-panel object-cover max-sm:size-31.5"
                  src={brand.assets.wechatAvatar}
                  alt="林昂在路上公众号品牌头像"
                  width={1254}
                  height={1254}
                  sizes="128px"
                />
              )}
              <div className="min-w-0">
                {brand.wechatQrCode && (
                  <div className="mb-5.5 flex items-center gap-3.5">
                    <Image
                      className="size-16 border-2 border-on-panel object-cover"
                      src={brand.assets.wechatAvatar}
                      alt="林昂在路上公众号品牌头像"
                      width={1254}
                      height={1254}
                      sizes="64px"
                    />
                    <div className="flex flex-col leading-[1.35]">
                      <span className="text-[13px] text-on-panel-soft">微信公众号</span>
                      <strong className="mt-0.75 text-[21px]">{brand.chineseName}</strong>
                    </div>
                  </div>
                )}
                <p className="mb-4.5 text-lg">
                  {brand.wechatQrCode ? "也可在微信内搜索：" : "在微信内搜索："}
                  <strong>{brand.chineseName}</strong>
                </p>
                <CopyWechatButton />
                {brand.socialLinks.map((link, index) => (
                  <a
                    className={`inline-flex w-fit items-center gap-2 border-b border-[rgba(247,245,239,0.34)] py-1.75 text-[15px] font-[750] transition-[color,border-color] duration-180 hover:border-brand-orange hover:text-brand-orange [&_svg]:size-4 ${index > 0 ? "ml-4.5 max-sm:ml-3.5" : ""}`}
                    href={link.href}
                    key={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.cta}
                    <ExternalLink aria-hidden="true" />
                  </a>
                ))}
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="bg-page py-12.5">
        <div className="mx-auto grid w-[min(1200px,calc(100%_-_48px))] grid-cols-[1fr_auto_auto] items-end gap-11.5 max-[899px]:w-[min(calc(100%_-_40px),720px)] max-sm:w-[calc(100%_-_40px)] max-sm:grid-cols-[1fr_auto] max-sm:gap-8">
          <div className="flex flex-col leading-[1.2]">
            <strong className="text-[35px] tracking-[-0.05em]">{brand.englishName}</strong>
            <span className="mt-1.5 text-lg font-[750] tracking-[0.16em]">{brand.chineseName}</span>
            <small className="mt-3.25 text-[9px] font-bold tracking-[0.28em]">{brand.slogan}</small>
          </div>
          <p className="mb-0 text-[13px] text-muted max-sm:col-span-full max-sm:row-start-2">
            © <CurrentYear /> {brand.englishName}. All rights reserved.
          </p>
          <a className="flex flex-col items-center gap-2 text-[13px] [&_svg]:size-5" href="#top">
            <ArrowUp aria-hidden="true" />
            返回顶部
          </a>
        </div>
      </footer>
    </>
  );
}
