import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";

export interface FixtureDefinition {
  id: string;
  label: string;
  path: string;
  marker: string;
  /** Muted autoplay specimen that must remain playing across the viewer's snapshot bridge. */
  mediaSelector?: string;
  /** Selector of a same-origin child frame that owns the interaction panel. */
  interactionFrame?: string;
  /** Absolute URL and interaction profile are used only by the opt-in live-site lane. */
  url?: string;
  interactionProfile?: "wikipedia" | "hacker-news";
}

export interface FixtureSite {
  server: Server;
  url: string;
  port: number;
  fixtures: FixtureDefinition[];
  network: { activeRequests: number; lastActivityAt: number };
}

export const DETERMINISTIC_FIXTURES: FixtureDefinition[] = [
  {
    id: "same-origin-embed",
    label: "Same-origin iframe",
    path: "/fixtures/embed",
    marker: "Same-origin document set",
    interactionFrame: "#source-frame",
  },
  {
    id: "content",
    label: "Content page",
    path: "/fixtures/content",
    marker: "Fidelity Field Notes",
  },
  {
    id: "autoplay-media",
    label: "Autoplay media",
    path: "/fixtures/media",
    marker: "Autoplay media checkpoint",
    mediaSelector: "#autoplay-video",
  },
  { id: "feed", label: "List / feed", path: "/fixtures/feed", marker: "Deterministic News Feed" },
  { id: "form", label: "Form page", path: "/fixtures/form", marker: "Registration Lab" },
  {
    id: "react-spa",
    label: "React SPA",
    path: "/fixtures/react",
    marker: "React fixture dashboard",
  },
  {
    id: "shadow-nested",
    label: "Nested + open shadow",
    path: "/fixtures/shadow",
    marker: "Nested shadow specimen",
  },
];

const require = createRequire(import.meta.url);
const reactPath = resolve(
  dirname(require.resolve("react/package.json")),
  "umd/react.production.min.js",
);
const reactDomPath = resolve(
  dirname(require.resolve("react-dom/package.json")),
  "umd/react-dom.production.min.js",
);
const mediaWebm = Buffer.from(
  "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",
  "base64",
);

export async function startFixtureSite(): Promise<FixtureSite> {
  const [react, reactDom] = await Promise.all([readFile(reactPath), readFile(reactDomPath)]);
  const network = { activeRequests: 0, lastActivityAt: Date.now() };
  const server = createServer((request, response) => {
    network.activeRequests += 1;
    network.lastActivityAt = Date.now();
    response.once("finish", () => {
      network.activeRequests -= 1;
      network.lastActivityAt = Date.now();
    });
    response.setHeader("cache-control", "no-store");
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "fixture.test"}`,
    );

    if (request.method !== "GET") {
      response.writeHead(405).end("method not allowed");
      return;
    }
    if (requestUrl.pathname === "/vendor/react.production.min.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(react);
      return;
    }
    if (requestUrl.pathname === "/vendor/react-dom.production.min.js") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(reactDom);
      return;
    }
    if (requestUrl.pathname === "/fixtures/autoplay.webm") {
      response.setHeader("content-type", "video/webm");
      response.setHeader("content-length", String(mediaWebm.byteLength));
      response.end(mediaWebm);
      return;
    }

    const html = fixtureHtml(requestUrl.pathname, requestUrl.hostname, requestUrl.port);
    if (html === undefined) {
      response.writeHead(404).end("not found");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(html);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    fixtures: DETERMINISTIC_FIXTURES,
    network,
  };
}

export function closeFixtureSite(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

function fixtureHtml(pathname: string, hostname = "127.0.0.1", port = "80"): string | undefined {
  switch (pathname) {
    case "/fixtures/content":
      return page(
        "Fidelity Field Notes",
        `<main data-diff-root>
          <article><header><p class="eyebrow">Engineering notebook · issue 12</p>
          <h1>Fidelity Field Notes</h1></header>
          <p>A semantic mirror should preserve readable prose, navigation, and form state.</p>
          <h2>Stable observations</h2>
          <p>Deterministic fixtures keep the measurement signal separate from advertising,
          personalization, clocks, and animation churn.</p>
          <figure><img alt="Blue fidelity grid" src="${imageData("Content")}"><figcaption>A local data image.</figcaption></figure>
          </article>${interactionPanel()}
        </main>`,
      );
    case "/fixtures/feed":
      return page(
        "Deterministic News Feed",
        `<main data-diff-root><header><h1>Deterministic News Feed</h1><p>Five stable updates</p></header>
          <ol class="feed">
            ${[1, 2, 3, 4, 5]
              .map(
                (index) => `<li><article><h2>Update ${index}: mirror checkpoint</h2>
                  <p>Sequence ${index * 10} reached the viewer without a gap.</p>
                  <time datetime="2026-07-${String(index).padStart(2, "0")}">Day ${index}</time></article></li>`,
              )
              .join("")}
          </ol>${interactionPanel()}</main>`,
      );
    case "/fixtures/form":
      return page(
        "Registration Lab",
        `<main data-diff-root><h1>Registration Lab</h1>
          <form class="profile" onsubmit="event.preventDefault()">
            <fieldset><legend>Profile snapshot</legend>
              <label>Display name <input id="profile-name" value="Ada Mirror"></label>
              <label>Notes <textarea id="profile-notes">Stable textarea value</textarea></label>
              <label>Region <select id="profile-region"><option selected>North</option><option>South</option></select></label>
            </fieldset>
          </form>${interactionPanel()}</main>`,
      );
    case "/fixtures/media":
      return page(
        "Autoplay media checkpoint",
        `<main data-diff-root><h1>Autoplay media checkpoint</h1>
          <p>The mirrored muted loop must remain live after every full snapshot.</p>
          <video id="autoplay-video" autoplay muted loop playsinline preload="auto"
            width="320" height="240" src="/fixtures/autoplay.webm"></video>
          ${interactionPanel()}</main>`,
      );
    case "/fixtures/react":
      return reactPage();
    case "/fixtures/embed":
      return page(
        "Same-origin document set",
        `<main data-diff-root><h1>Same-origin document set</h1>
          <p>The stable controls live in a real child document.</p>
          <iframe id="source-frame" name="p2-diff-embed" title="Embedded interaction fixture" src="/fixtures/embed-child"></iframe>
        </main>`,
      );
    case "/fixtures/embed-child":
      return page(
        "Embedded controls",
        `<main data-diff-root><h1>Embedded controls</h1><p>Input must cross the document set.</p>
          ${interactionPanel()}</main>`,
      );
    case "/fixtures/oopif":
      return oopifParentPage(port);
    case "/fixtures/oopif-child":
      return oopifChildPage(hostname);
    case "/fixtures/live-youtube-embed":
      return liveEmbedPage(
        "YouTube embed advisory",
        "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ",
        "youtube-advisory-frame",
      );
    case "/fixtures/live-consent-iframe":
      return liveEmbedPage(
        "Consent iframe advisory",
        "https://consent.google.com/",
        "consent-advisory-frame",
      );
    case "/fixtures/shadow":
      return shadowPage();
    default:
      return undefined;
  }
}

function oopifParentPage(port: string): string {
  return page(
    "Cross-site OOPIF host",
    `<main data-diff-root><h1 id="oopif-parent-marker">a.test parent intact</h1>
      <p id="oopif-parent-state">The parent must survive every child lifecycle transition.</p>
      <iframe id="oopif-frame" name="p2-diff-oopif" title="Cross-site OOPIF fixture"
        src="http://b.test:${port}/fixtures/oopif-child"></iframe>
    </main>`,
  );
}

function oopifChildPage(hostname: string): string {
  const site = hostname === "a.test" ? "a.test folded" : hostname;
  return page(
    `${site} embedded controls`,
    `<main data-diff-root><h1 id="oopif-child-marker" data-site="${hostname}">${site} child content</h1>
      <p id="oopif-child-location">${hostname} interaction surface</p>
      <oopif-closed-card id="oopif-closed-card"></oopif-closed-card>
      ${interactionPanel()}</main>`,
    `const card=document.querySelector("#oopif-closed-card");
     const closed=card.attachShadow({mode:"closed"});
     closed.innerHTML='<article><h2>Closed shadow inside OOPIF</h2><p>Serialized child shadow witness</p></article>';`,
  );
}

function liveEmbedPage(title: string, src: string, id: string): string {
  return page(
    title,
    `<main data-diff-root><h1>${title}</h1>
      <p data-diff-ignore>Public embed content is advisory and network-dependent.</p>
      <iframe id="${id}" title="${title}" src="${src}" allow="encrypted-media; fullscreen"></iframe>
    </main>`,
  );
}

function page(title: string, body: string, extraScript = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>${title}</title><style>${styles()}</style></head><body>${body}
    <script>${interactionScript()}${extraScript}</script></body></html>`;
}

function interactionPanel(): string {
  return `<section class="interaction" aria-labelledby="interaction-heading">
    <h2 id="interaction-target">Interaction checkpoint</h2>
    <a id="action-link" href="#interaction-target">Activate anchor target</a>
    <form id="interaction-form" onsubmit="event.preventDefault()">
      <label for="field-a">First field</label><input id="field-a" value="alpha" autocomplete="off">
      <label for="field-b">Second field</label><input id="field-b" value="" autocomplete="off">
      <label for="choice">Mode</label><select id="choice"><option value="alpha">Alpha</option><option value="beta">Beta</option><option value="gamma">Gamma</option></select>
    </form>
    <p id="action-output" aria-live="polite">Interaction idle</p>
    <div id="scroll-surface" data-diff-scroll><div class="scroll-content">Scroll origin<br>${"stable scroll row<br>".repeat(
      16,
    )}Scroll destination</div></div>
  </section>`;
}

function interactionScript(): string {
  return `document.addEventListener("DOMContentLoaded",()=>{const link=document.querySelector("#action-link");
    const output=document.querySelector("#action-output");
    link?.addEventListener("click",()=>{if(output)output.textContent="Anchor activated on server";});
  });`;
}

function reactPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>React fixture dashboard</title><style>${styles()}</style></head><body>
    <div id="app" data-diff-root></div>
    <script src="/vendor/react.production.min.js"></script>
    <script src="/vendor/react-dom.production.min.js"></script>
    <script>
      const e=React.createElement;
      function App(){
        const [first,setFirst]=React.useState("alpha");
        const [second,setSecond]=React.useState("");
        const [choice,setChoice]=React.useState("alpha");
        const [route,setRoute]=React.useState("dashboard");
        return e(React.Fragment,null,
          e("header",null,e("h1",null,"React fixture dashboard"),e("p",null,"Route: ",route)),
          e("nav",null,e("button",{id:"spa-route",onClick:()=>{history.pushState({},"","#details");setRoute("details")}},"Open details")),
          e("section",{className:"cards"},[1,2,3].map(n=>e("article",{key:n},e("h2",null,"Card "+n),e("p",null,"Controlled render "+n)))),
          e("section",{className:"interaction","aria-labelledby":"interaction-target"},
            e("h2",{id:"interaction-target"},"Interaction checkpoint"),
            e("a",{id:"action-link",href:"#interaction-target",onClick:()=>setRoute("anchor-activated")},"Activate anchor target"),
            e("form",{id:"interaction-form",onSubmit:event=>event.preventDefault()},
              e("label",{htmlFor:"field-a"},"First field"),e("input",{id:"field-a",value:first,autoComplete:"off",onChange:event=>setFirst(event.target.value)}),
              e("label",{htmlFor:"field-b"},"Second field"),e("input",{id:"field-b",value:second,autoComplete:"off",onChange:event=>setSecond(event.target.value)}),
              e("label",{htmlFor:"choice"},"Mode"),e("select",{id:"choice",value:choice,onChange:event=>setChoice(event.target.value)},
                e("option",{value:"alpha"},"Alpha"),e("option",{value:"beta"},"Beta"),e("option",{value:"gamma"},"Gamma"))),
            e("p",{id:"action-output","aria-live":"polite"},route==="anchor-activated"?"Anchor activated on server":"Interaction idle"),
            e("div",{id:"scroll-surface","data-diff-scroll":true},e("div",{className:"scroll-content"},"Scroll origin",e("br"),
              Array.from({length:16},(_,n)=>e(React.Fragment,{key:n},"stable scroll row",e("br"))),"Scroll destination")))
        );
      }
      ReactDOM.createRoot(document.querySelector("#app")).render(e(App));
    </script></body></html>`;
}

function shadowPage(): string {
  return page(
    "Nested shadow specimen",
    `<main data-diff-root><h1>Nested shadow specimen</h1><p>Light DOM surrounds an open shadow tree.</p>
      <section><div><article><h2>Deep light-DOM branch</h2><p>Three nested semantic levels.</p></article></div></section>
      <fidelity-card id="shadow-card"></fidelity-card>${interactionPanel()}</main>`,
    `const host=document.querySelector("#shadow-card");const root=host.attachShadow({mode:"open"});
     root.innerHTML='<style>:host{display:block;border:2px solid #546;padding:12px}</style><article><h2>Open shadow content</h2><p>Nested shadow text and <strong>semantic emphasis</strong>.</p><img alt="Shadow grid" src="${imageData("Shadow")}"></article>';`,
  );
}

function imageData(label: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#dce8ff"/><path d="M0 20h160M0 40h160M0 60h160M40 0v80M80 0v80M120 0v80" stroke="#567"/><text x="8" y="16" font-size="12">${label}</text></svg>`,
  )}`;
}

function styles(): string {
  return `*{box-sizing:border-box}html{scroll-behavior:auto}body{font:16px/1.45 system-ui,sans-serif;color:#172033;background:#fff;margin:24px;max-width:920px}
    h1,h2,p{margin-block:8px}main{display:block}.eyebrow{letter-spacing:.08em;text-transform:uppercase}.feed{padding-left:28px}.feed li{margin:12px 0}
    img{display:block;width:160px;height:80px}.profile,.interaction{border:1px solid #9aa8bd;border-radius:8px;padding:16px;margin-top:22px}
    label,input,select{display:block}input,select,button{font:inherit;padding:7px;margin:4px 0 10px;min-width:260px}
    #action-link{display:inline-block;padding:6px 0}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.cards article{border:1px solid #ccd5e3;padding:10px}
    #scroll-surface{width:420px;height:120px;overflow:auto;border:2px solid #4d6382;padding:8px;overscroll-behavior:contain}.scroll-content{height:620px}
    iframe{display:block;width:760px;height:600px;border:3px solid #536b8d;margin-top:12px}`;
}
