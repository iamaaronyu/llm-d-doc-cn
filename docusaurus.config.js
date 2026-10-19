// @ts-check
// See https://docusaurus.io/docs/api/docusaurus-config
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { themes as prismThemes } from 'prism-react-renderer';
import { makeDocsPreprocessor } from './scripts/lib/preprocess.mjs';
import { loadMenuConfig, makeSidebarItemsGenerator, validateMenuConfig } from './scripts/lib/sidebar.mjs';
import redirects from './redirects.js';

import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

const GITHUB_REPO = 'https://github.com/llm-d/llm-d';

// Self-adjusting versioning: derive the version map from versions.json (which
// docusaurus writes newest-first). The newest release is served at /docs and the
// rest at /docs/<version>; the committed dev docs/ are the unreleased "dev"
// version at /docs/dev. Reading the file lets `llmd-site version cut` recreate
// versioned_docs/ without the config hard-coding a version that may be absent.
const siteDir = path.dirname(fileURLToPath(import.meta.url));
// menu-config.json is authored in llm-d/llm-d (docs/menu-config.json) and synced
// into docs/ alongside the docs it describes. It may be absent before the first
// sync, so loadMenuConfig tolerates a missing file and we only validate when docs/ exists.
const docsDir = path.join(siteDir, 'docs');
const menuConfig = loadMenuConfig(path.join(docsDir, 'menu-config.json'));
if (fs.existsSync(docsDir)) validateMenuConfig(menuConfig, docsDir);
const versionsFile = path.join(siteDir, 'versions.json');
/** @type {string[]} */
const releasedVersions = fs.existsSync(versionsFile)
  ? JSON.parse(fs.readFileSync(versionsFile, 'utf8'))
  : [];
const LATEST_VERSION = releasedVersions[0];
const docsVersions = LATEST_VERSION
  ? {
      lastVersion: LATEST_VERSION,
      versions: {
        // Released versions first (newest = default at /docs, older at /docs/<v>),
        // then the unreleased dev version last — this is the version dropdown order.
        ...Object.fromEntries(
          releasedVersions.map((v) => [
            v,
            {
              // Mark the default (newest) release, served at /docs, as "(latest)".
              label: v === LATEST_VERSION ? `v${v} (latest)` : `v${v}`,
              path: v === LATEST_VERSION ? '' : v,
              badge: true,
            },
          ]),
        ),
        current: { label: 'dev', path: 'dev', banner: 'unreleased' },
      },
    }
  : {};

/** Docs are synced from llm-d/llm-d into docs/ (see tools/llmd-site).
 *  Map a synced doc back to its source file for the "Edit this page" link.
 *  @type {import('@docusaurus/plugin-content-docs').EditUrlFunction} */
function docsEditUrl({ versionDocsDirPath, docPath }) {
  // Only the current ("next") version maps cleanly back to the live source tree.
  if (versionDocsDirPath !== 'docs') return undefined;
  return `${GITHUB_REPO}/edit/main/docs/${docPath}`;
}

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "llm-d",
  tagline: "Kubernetes 原生的高性能分布式 LLM 推理（中文文档）",
  favicon: "img/llm-d-favicon.png",

  url: "https://llm-d-zh.example.com",
  baseUrl: "/",

  organizationName: "llm-d",
  projectName: "llm-d",

  trailingSlash: false,
  onBrokenLinks: "warn",
  onBrokenAnchors: "warn",

  i18n: {
    defaultLocale: "zh-Hans",
    locales: ["zh-Hans"],
  },

  markdown: {
    // .md -> CommonMark (forgiving of the raw HTML in the synced GitHub docs),
    // .mdx -> MDX (blog posts, community index/events, getting-started).
    format: "detect",
    mermaid: true,
    // Render-time link/image/brace fixes for the pristine synced docs copy.
    preprocessor: makeDocsPreprocessor({ docsDir }),
    hooks: {
      onBrokenMarkdownLinks: "warn",
      onBrokenMarkdownImages: "warn",
    },
  },


  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: "docs",
          remarkPlugins: [remarkMath],
          rehypePlugins: [rehypeKatex],
          routeBasePath: "docs",
          sidebarPath: "./sidebars.js",
          editUrl: docsEditUrl,
          sidebarItemsGenerator: makeSidebarItemsGenerator(menuConfig),
          // Native versioning: the synced docs/ are the unreleased "dev" version;
          // released versions are frozen snapshots under versioned_docs/.
          includeCurrentVersion: true,
          ...docsVersions,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
        sitemap: {
          changefreq: "weekly",
          priority: 0.5,
          ignorePatterns: ["/tags/**"],
        },
      }),
    ],
  ],

  plugins: [
    // Client-side redirects for URLs that have moved; the list lives in redirects.js.
    ["@docusaurus/plugin-client-redirects", { redirects }],
  ],

  stylesheets: ["/vendor/katex/katex.min.css"],
  themes: [
    "@docusaurus/theme-mermaid",
    // 离线全文搜索（仅文档，支持中文分词）。
    /** @type {import('@docusaurus/types').PluginConfig} */
    ([
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        indexBlog: false,
        language: ["zh", "en"],
        indexPages: true,
        docsRouteBasePath: ["/docs"],
        highlightSearchTermsOnTargetPage: true,
      },
    ]),
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: "img/llm-d-social-card.jpg",
      colorMode: {
        respectPrefersColorScheme: true,
      },
      announcementBar: {
        id: "llm-d-zh-0-10",
        content:
          '本站为 <b>llm-d v0.10</b> 官方文档的社区中文翻译，内容以 <a href="https://llm-d.ai/docs" target="_blank" rel="noreferrer noopener">英文原版</a> 为准。',
        textColor: "#ffffff",
        isCloseable: true,
      },
      docs: {
        sidebar: {
          hideable: true,
          autoCollapseCategories: false,
        },
      },
      navbar: {
        logo: {
          alt: "llm-d",
          src: "img/llm-d-logotype-and-icon.svg",
          srcDark: "img/llm-d-logotype-and-icon-dark.svg",
          href: "/",
        },
        items: [
          {
            // Plain link (not a version-aware docSidebar item) so "Docs" always
            // opens the latest release at /docs, regardless of the version the
            // visitor last viewed (dev/0.7 are reachable via the dropdown).
            to: "/docs",
            position: "left",
            label: "文档",
          },
          {
            href: "https://llm-d.ai/docs",
            position: "left",
            label: "英文原版",
          },
          {
            // GitHub icon + live star count (see src/components/GithubStarsNavbarItem).
            type: "custom-githubStars",
            href: GITHUB_REPO,
            position: "right",
            "aria-label": "GitHub repository",
          },
          {
            href: "https://llm-d.ai/slack",
            position: "right",
            className: "header-slack-link",
            label: "加入 Slack",
            "aria-label": "llm-d Slack",
          },
        ],
      },
      footer: {
        style: "dark",
        logo: {
          alt: "llm-d Logo",
          src: "img/cncf-color.svg",
          srcDark: "img/cncf-white.png",
          href: "https://cncf.io",
          target: "_blank",
          width: 240,
          className: "footer-logo",
          style: {
            marginRight: "10px",
          },
        },
        links: [
          {
            title: "文档",
            items: [
              {
                html: '<a href="/docs" class="footer__link-item">快速入门</a>',
              },
              {
                html: '<a href="/docs/architecture" class="footer__link-item">架构</a>',
              },
              {
                html: '<a href="/docs/well-lit-paths" class="footer__link-item">成熟路径</a>',
              },
            ],
          },
          {
            title: "社区与原站",
            items: [
              { label: "llm-d 官网（英文）", href: "https://llm-d.ai" },
              { label: "参与贡献", href: "https://llm-d.ai/community/contribute" },
              { label: "GitHub：llm-d/llm-d", href: "https://github.com/llm-d/llm-d" },
            ],
          },
          {
            title: "Social",
            items: [
              {
                html: `
                <div class="footer-socials" role="navigation" aria-label="Social links">
                  <div class="footer-socials-row">
                    <a href="https://github.com/llm-d/" target="_blank" rel="noreferrer noopener" aria-label="GitHub">
                      <img src="/img/new-social/github-mark-white.png" alt="GitHub" />
                    </a>
                    <a href="https://linkedin.com/company/llm-d" target="_blank" rel="noreferrer noopener" aria-label="LinkedIn">
                      <img src="/img/new-social/linkedin-mark-white.png" alt="LinkedIn" />
                    </a>
                    <a href="https://llm-d.slack.com" target="_blank" rel="noreferrer noopener" aria-label="Slack">
                      <img src="/img/new-social/slack-mark-white.png" alt="Slack" />
                    </a>
                    <a href="https://www.reddit.com/r/llm_d/" target="_blank" rel="noreferrer noopener" aria-label="Reddit">
                      <img src="/img/new-social/reddit-mark-white.png" alt="Reddit" />
                    </a>
                    <a href="https://bsky.app/profile/llm-d.ai" target="_blank" rel="noreferrer noopener" aria-label="Bluesky">
                      <img src="/img/new-social/bluesky-mark-white.svg" alt="Bluesky" />
                    </a>
                    <a href="https://x.com/_llm_d_" target="_blank" rel="noreferrer noopener" aria-label="X / Twitter">
                      <img src="/img/new-social/x-mark-white.png" alt="X / Twitter" />
                    </a>
                    <a href="https://www.youtube.com/@llm-d-project" target="_blank" rel="noreferrer noopener" aria-label="YouTube">
                      <img src="/img/new-social/youtube-mark-white.svg" alt="YouTube" />
                    </a>
                  </div>
                  <div class="footer-cncf">
                    <img class="footer-cncf-logo" src="/img/CNCF-logo.svg" alt="CNCF" />
                    <span>llm-d 是 CNCF 沙箱项目</span>
                  </div>
                  <div class="footer-socials-cta">
                    <a href="https://llm-d.ai/slack" target="_blank" rel="noreferrer noopener" aria-label="Join our Slack">
                      <span class="button-link">加入我们的 Slack</span>
                    </a>
                  </div>
                </div>
              `,
              },
            ],
          },
        ],
        copyright: `本站为 <a href="https://llm-d.ai/docs" target="_blank" rel="noreferrer noopener">llm-d 官方文档</a>（v0.10）的非官方中文翻译，原文版权归 llm-d a Series of LF Projects, LLC 所有，依据 Apache 2.0 许可证翻译与再分发；如有出入，以英文原版为准。<br />\
        llm-d 是云原生计算基金会（CNCF）沙箱项目。网站使用条款、商标政策及其他项目政策请参阅 <a href="https://lfprojects.org/policies/" target="_blank" rel="noreferrer noopener">https://lfprojects.org/policies/</a>`,
      },
      prism: {
        theme: prismThemes.oneLight,
        darkTheme: prismThemes.oneDark,
        additionalLanguages: ["bash", "yaml", "json", "toml", "promql"],
      },
      mermaid: {
        theme: { light: "neutral", dark: "dark" },
      },
    }),
};

export default config;
