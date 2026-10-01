import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderConfigEditor, ConfigEditError } from "../packages/adapters/dist/config/provider-config-editor.js";
import { materializeUnifiedConfig, resolveUnifiedConfig } from "../packages/adapters/dist/config/provider-config.js";
import { startAdminServer } from "../packages/cli/src/admin/server.ts";
import { ADMIN_SCRIPT } from "../packages/cli/src/admin/client.ts";
import { testProviderConnection } from "../packages/cli/src/admin/test-connection.ts";
const document = () => ({ provider: "api", model: "model-b", providers: [{ id: "api", type: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "private-admin-test-key", contextWindow: 512000, models: [{ id: "model-a" }, { id: "model-b", type: "anthropic", baseUrl: "https://anthropic.example/v1", apiKey: "private-model-key", vision: false }] }] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-admin-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const dataRoot=join(root,"user"); await mkdir(dataRoot); await mkdir(join(root,".comecode")); await writeFile(join(root,".comecode","config.json"),"{}"); await writeFile(join(dataRoot,"config.json"),JSON.stringify(document()));
  return {root, dataRoot, cwd:root, env:{}, targetProviderFile:join(dataRoot,"v2","provider_config.json")};
}
test("网页读取有效旧 Provider 时仍展示模型，保存草稿保留旧密钥", async t => {
  const f = await fixture(t);
  await rm(join(f.dataRoot, "config.json"));
  await mkdir(join(f.dataRoot, "v2"), { recursive: true });
  await writeFile(join(f.dataRoot, "v2", "provider_config.json"), JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{ providerId: "legacy-api", config: {
          api: { type: "openai-chat-completions", baseUrl: "https://legacy.example/v1" },
          access: { apiKey: "private-legacy-key" },
          personalModelIds: ["legacy-model"],
        } }],
      },
      defaultModelSelection: { providerId: "legacy-api", modelId: "legacy-model" },
    },
  }));
  const editor = createProviderConfigEditor(f);
  const before = await editor.read();
  assert.equal(before.config.providers.length, 0);
  assert.equal(before.effective.providers.length, 1);
  assert.equal(before.effective.providers[0].models[0].id, "legacy-model");
  assert.doesNotMatch(JSON.stringify(before), /private-legacy-key/u);

  const draft = {
    provider: "legacy-api",
    model: "legacy-model",
    providers: [{
      id: "legacy-api",
      type: "openai-chat",
      baseUrl: "https://legacy.example/v1",
      hasApiKey: true,
      models: [{ id: "legacy-model", hasApiKey: true }],
    }],
  };
  await editor.save({ revision: before.revision, config: draft });
  const saved = JSON.parse(await readFile(join(f.dataRoot, "config.json"), "utf8"));
  assert.equal(saved.providers[0].apiKey, "private-legacy-key");
  assert.equal(saved.providers[0].models[0].id, "legacy-model");
});
test("网页编辑保存保留未改密钥、模型能力、备份、版本冲突与非托管文件", async t=>{
  const f=await fixture(t), editor=createProviderConfigEditor(f); const before=await editor.read();
  assert.doesNotMatch(JSON.stringify(before),/private-admin-test-key|private-model-key/u);
  const config=before.config;config.providers[0].name="修改后的服务";config.providers[0].models[1].vision=true;
  const after=await editor.save({revision:before.revision,config});assert.equal(after.saved,true);
  const actual=JSON.parse(await readFile(join(f.dataRoot,"config.json"),"utf8"));assert.equal(actual.providers[0].apiKey,"private-admin-test-key");assert.equal(actual.providers[0].models[1].apiKey,"private-model-key");assert.equal(actual.providers[0].models[1].vision,true);
  assert.match(await readFile(after.backup,"utf8"),/private-admin-test-key/u);
  await assert.rejects(editor.save({revision:before.revision,config}),error=>error instanceof ConfigEditError&&error.status===409);
  const next=after.config;next.providers[0].apiKeyEnv="ADMIN_ENV_KEY";next.providers[0].clearApiKey=true;
  const envEditor=createProviderConfigEditor({...f,env:{ADMIN_ENV_KEY:"private-env-value"}});await envEditor.save({revision:after.revision,config:next});
  const saved=await readFile(join(f.dataRoot,"config.json"),"utf8");assert.doesNotMatch(saved,/private-admin-test-key|private-env-value/u);assert.match(saved,/ADMIN_ENV_KEY/u);
  assert.equal(await readFile(join(f.root,".comecode","config.json"),"utf8"),"{}");
});
test("JSONC/TOML 迁移需确认，未知字段不允许覆盖，第二页面保存冲突",async t=>{
  const f=await fixture(t);await rm(join(f.dataRoot,"config.json"));await writeFile(join(f.dataRoot,"config.toml"),'model = "model-a"\nprovider = "api"\n[providers.api]\ntype = "openai-chat"\napi_key = "toml-private-key"\n');
  const editor=createProviderConfigEditor(f), before=await editor.read();assert.equal(before.requiresMigration,true);
  await assert.rejects(editor.save({revision:before.revision,config:before.config}),{status:409});
  const results=await Promise.allSettled([editor.save({revision:before.revision,config:before.config,migrate:true}),editor.save({revision:before.revision,config:before.config,migrate:true})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(await readFile(join(f.dataRoot,"config.toml"),"utf8"),/toml-private-key/u);
  await writeFile(join(f.dataRoot,"config.json"),'{"unknown":true}');const broken=await editor.read();assert.ok(broken.errors.length);await assert.rejects(editor.save({revision:broken.revision,config:{providers:[]}}),{status:422});
});
test("网页删除供应商后不会从派生旧 JSON 复活",async t=>{
  const f=await fixture(t);await materializeUnifiedConfig(f);const editor=createProviderConfigEditor(f),before=await editor.read();
  await editor.save({revision:before.revision,config:{providers:[]}});
  const resolved=await resolveUnifiedConfig({...f,legacyProviderFile:f.targetProviderFile});assert.equal(resolved.providers.length,0);
  await materializeUnifiedConfig({...f,legacyProviderFile:f.targetProviderFile});
  const runtime=JSON.parse(await readFile(f.targetProviderFile,"utf8"));assert.equal(runtime.config.providerConfigRules.providerRules.length,0);assert.equal(runtime.config.defaultModelSelection,undefined);
});
test("网页模型配置支持同地址归类所需的多模型结构与供应商改名", async t => {
  const f = await fixture(t), editor = createProviderConfigEditor(f);
  const before = await editor.read();
  const config = before.config;
  config.providers[0].name = "我的模型服务";
  config.providers[0].models.push({ id: "model-c", name: "模型 C" });
  const after = await editor.save({ revision: before.revision, config });
  const saved = JSON.parse(await readFile(join(f.dataRoot, "config.json"), "utf8"));
  assert.equal(saved.providers.length, 1);
  assert.equal(saved.providers[0].name, "我的模型服务");
  assert.deepEqual(saved.providers[0].models.map(model => typeof model === "string" ? model : model.id), ["model-a", "model-b", "model-c"]);
  assert.equal(after.config.providers[0].models.length, 3);
});
test("停用默认模型时保留停用配置并自动切换默认模型", async t => {
  const f = await fixture(t), editor = createProviderConfigEditor(f);
  const before = await editor.read();
  const config = before.config;
  config.provider = "api";
  config.model = "model-a";
  config.providers[0].models[0].enabled = false;
  const after = await editor.save({ revision: before.revision, config });
  assert.equal(after.saved, true);
  const saved = JSON.parse(await readFile(join(f.dataRoot, "config.json"), "utf8"));
  assert.equal(saved.providers[0].models[0].enabled, false);
  assert.equal(saved.provider, "api");
  assert.equal(saved.model, "model-b");
  const resolved = await resolveUnifiedConfig(f);
  assert.equal(resolved.model, "model-b");
  assert.equal(resolved.providers[0].modelConfigs.find(model => model.id === "model-a").executable, false);
});
test("管理页前端脚本保持可执行语法", () => {
  // 页面脚本一旦语法错误，浏览器不会发起配置请求，只会停在“正在读取配置”。
  assert.doesNotThrow(() => new vm.Script(ADMIN_SCRIPT));
});
test("HTTP 鉴权、同源、Host、CSP、脱敏、体积限制和保存",async t=>{
  const f=await fixture(t),server=await startAdminServer(f);t.after(()=>server.close());const token=new URLSearchParams(new URL(server.url).hash.slice(1)).get('token');const headers={Authorization:'Bearer '+token};
  assert.equal((await fetch(server.origin+'/api/config')).status,401);assert.equal((await fetch(server.origin+'/api/config',{headers:{...headers,Origin:'https://evil.test'}})).status,403);
  const { request } = await import('node:http');
  const wrongHost = await new Promise(resolve => { const req=request(server.origin+'/api/config',{headers:{...headers,Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.end(); });
  assert.equal(wrongHost,403);
  const response=await fetch(server.origin+'/api/config',{headers});const before=await response.json();assert.equal(response.status,200);assert.doesNotMatch(JSON.stringify(before),/private-admin-test-key|private-model-key/u);
  const html=await fetch(server.origin);const htmlText=await html.text();assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/u);assert.equal(html.headers.get('cache-control'),'no-store');assert.match(htmlText,/模型列表/u);assert.match(htmlText,/编辑供应商/u);
  assert.equal((await fetch(server.origin+'/api/config',{method:'PUT',headers,body:'{}'})).status,415);
  assert.equal((await fetch(server.origin+'/api/config',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:'x'.repeat(270000)})).status,413);
  const config=before.config;config.providers[0].models.push({id:'model-c',contextWindow:128000});
  assert.equal((await fetch(server.origin+'/api/config',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({revision:before.revision,config})})).status,200);
  assert.equal((await fetch(server.origin+'/api/missing',{headers})).status,404);
});
test("三种协议连接测试沿用有效模型与凭据，失败不回显正文且必须确认",async t=>{
  const f=await fixture(t),doc=document();doc.providers[0].models.push({id:'responses',type:'openai-responses'});await writeFile(join(f.dataRoot,'config.json'),JSON.stringify(doc));const config=await resolveUnifiedConfig(f);
  for(const [model,suffix,key] of [['model-a','/chat/completions','private-admin-test-key'],['model-b','/messages','private-model-key'],['responses','/responses','private-admin-test-key']]){
    let request;const result=await testProviderConnection({provider:'api',model,confirm:true},config,async(url,options)=>{request={url,options};return new Response('private-remote-response',{status:401});});
    assert.ok(request.url.endsWith(suffix));assert.ok(Object.values(request.options.headers).some(value=>value===key||value==='Bearer '+key));assert.equal(JSON.parse(request.options.body).model,model);assert.doesNotMatch(JSON.stringify(result),/private-/u);
  }
  await assert.rejects(testProviderConnection({provider:'api',model:'model-a'},config),{status:400});
  const failed=await testProviderConnection({provider:'api',model:'model-a',confirm:true},config,async()=>{throw new Error('private-key');});assert.doesNotMatch(JSON.stringify(failed),/private-key/u);
});

