#!/usr/bin/env node
/* Build a portable, offline design preview without altering the Next.js app. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const project = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "evelyn-shareable-"));
const destination = process.argv[2] || "/workspace/attachments/evelyn-crm-interaktiv.html";
const dependency = name => require.resolve(name, { paths: [project] });
const webpack = require(dependency("next/dist/compiled/webpack/webpack")).webpack;

function replaceOnce(text, before, after) {
  if (!text.includes(before)) throw new Error(`Portable adaptation no longer matches source: ${before.slice(0, 90)}`);
  return text.replace(before, after);
}

async function main() {
  fs.cpSync(path.join(project, "components"), path.join(temp, "components"), { recursive: true });
  fs.mkdirSync(path.join(temp, "app"));
  fs.mkdirSync(path.join(temp, "scripts"));
  fs.copyFileSync(path.join(project, "app/page.tsx"), path.join(temp, "app/page.tsx"));
  fs.copyFileSync(path.join(__dirname, "shareable-entry.tsx"), path.join(temp, "scripts/shareable-entry.tsx"));
  const demoPath = path.join(temp, "components/demo.tsx");
  let demo = fs.readFileSync(demoPath, "utf8");
  demo = replaceOnce(demo, 'useState<ViewId>("dashboard")', 'useState<ViewId>(()=>window.__EVELYN_INIT?.view||"dashboard")');
  demo = replaceOnce(demo, 'useState<TenantId>("atelier")', 'useState<TenantId>(()=>window.__EVELYN_INIT?.tenant||"atelier")');
  for (const variable of ["framed", "dark", "portal"]) {
    const setter = variable[0].toUpperCase() + variable.slice(1);
    demo = replaceOnce(demo, `const[${variable},set${setter}]=useState(false)`, `const[${variable},set${setter}]=useState(()=>!!window.__EVELYN_INIT?.${variable === "framed" ? "frame" : variable})`);
  }
  const initStart = demo.indexOf("useEffect(()=>{const read=");
  const initEnd = demo.indexOf("useEffect(()=>{if(!toast)", initStart);
  if (initStart < 0 || initEnd < 0) throw new Error("Portable Demo initialization not found");
  demo = demo.slice(0, initStart) + "useEffect(()=>{window.__EVELYN_CONTEXT={...window.__EVELYN_INIT,route:variant,view,tenant,dark,portal,frame:framed};},[variant,view,tenant,dark,portal,framed]);\n" + demo.slice(initEnd);
  demo = replaceOnce(demo, 'history.replaceState(null,"",`#${next}`);', "");
  demo = replaceOnce(demo, 'src={`/${variant}/?frame=1&tenant=${tenant}${dark?"&dark=1":""}${portal?"&portal=1":""}#${view}`}', 'srcDoc={window.__EVELYN_FRAME({route:variant,view,tenant,dark,portal,frame:true})}');
  fs.writeFileSync(demoPath, demo);
  const swc = dependency("next/dist/build/swc");
  await require(swc).loadBindings();
  const loader = path.join(temp, "swc-loader.cjs");
  fs.writeFileSync(loader, `const swc=require(${JSON.stringify(swc)});module.exports=function(source){const done=this.async();const isTS=/\\.tsx?$/.test(this.resourcePath);source=source.replace(/^import\\s+["'][^"']+\\.css["'];?\\s*$/gm,"");swc.transform(source,{filename:this.resourcePath,sourceMaps:false,jsc:{target:"es2020",parser:isTS?{syntax:"typescript",tsx:true}:{syntax:"ecmascript",jsx:true},transform:{react:{runtime:"automatic",development:false}}},module:{type:"es6"}}).then(result=>done(null,result.code),done);};`);
  const config = {
    mode: "production",
    context: temp,
    entry: path.join(temp, "scripts/shareable-entry.tsx"),
    output: { path: path.join(temp, "dist"), filename: "preview.js", publicPath: "", iife: true },
    devtool: false,
    resolve: { extensions: [".tsx", ".ts", ".js", ".jsx"], modules: [path.join(project, "node_modules"), "node_modules"] },
    module: { rules: [{ test: /\.[jt]sx?$/, exclude: /node_modules/, use: [{ loader }] }] },
    optimization: { minimize: false },
    performance: { hints: false },
  };
  await new Promise((resolve, reject) => webpack(config, (error, stats) => {
    if (error) return reject(error);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    resolve();
  }));
  const bundledScript = fs.readFileSync(path.join(temp, "dist/preview.js"), "utf8");
  const script = (await require(swc).minify(bundledScript, { compress: true, mangle: true })).code;
  const fontPath = path.join(project, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
  const fontCSS = fs.existsSync(fontPath) ? `@font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${fs.readFileSync(fontPath).toString("base64")}) format('woff2');}` : "";
  const css = fontCSS + ["app/globals.css", "components/executive.css", "components/friendly.css"].map(file => fs.readFileSync(path.join(project, file), "utf8").replace(/^@import[^;]*;\s*/gm, "")).join("\n");
  const licenses = Object.fromEntries(["react", "react-dom", "@fontsource-variable/inter"].map(name => [name, fs.readFileSync(path.join(project, "node_modules", name, "LICENSE"), "utf8")]));
  const payload = zlib.gzipSync(JSON.stringify({ css, js: script, licenses }), { level: 9 }).toString("base64");
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evelyn CRM – drei interaktive Designkonzepte</title><meta name="description" content="Drei interaktive Evelyn CRM Designkonzepte. Alle Daten sind synthetisch. Funktioniert ohne Server und ohne Internetverbindung."></head><body style="margin:0"><div id="root"><p style="font:16px/1.6 Arial,sans-serif;padding:28px">Evelyn Designvorschau wird geöffnet …</p></div><noscript>Bitte JavaScript aktivieren, um die drei Designs auszuprobieren.</noscript><script>(async()=>{try{const encoded="${payload}";const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));const data=JSON.parse(await new Response(stream).text());window.__EVELYN_CSS=data.css;window.__EVELYN_JS=data.js;const style=document.createElement("style");style.textContent=data.css;document.head.append(style);const script=document.createElement("script");script.textContent=data.js;document.body.append(script);}catch(error){document.getElementById("root").textContent="Die Vorschau konnte nicht geöffnet werden. Bitte einen aktuellen Browser verwenden. "+error.message;}})();</script></body></html>`;
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > 256 * 1024) throw new Error(`Preview exceeds Page visualization limit: ${bytes} bytes`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, html);
  const metadata = { destination, bytes, limitBytes: 256 * 1024, javascriptBytes: Buffer.byteLength(script), cssBytes: Buffer.byteLength(css), gzipPayloadBytes: Buffer.from(payload, "base64").length, sha256: crypto.createHash("sha256").update(html).digest("hex"), externalRequests: false, font: fs.existsSync(fontPath) ? "Inter Variable Latin, embedded" : "System fallback", createdAt: new Date().toISOString() };
  fs.writeFileSync(destination.replace(/\.html$/, ".build.json"), JSON.stringify(metadata, null, 2) + "\n");
  process.stdout.write(JSON.stringify(metadata, null, 2) + "\n");
}

main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
