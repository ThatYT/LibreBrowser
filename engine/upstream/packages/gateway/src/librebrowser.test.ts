import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngineGuard } from './librebrowser';

const oldToken=process.env.LIBREBROWSER_ENGINE_TOKEN;
afterEach(()=>{if(oldToken===undefined)delete process.env.LIBREBROWSER_ENGINE_TOKEN;else process.env.LIBREBROWSER_ENGINE_TOKEN=oldToken});
describe('LibreBrowser private engine boundary',()=>{
  it('requires broker credentials and the account session ID on all resources',async()=>{
    process.env.LIBREBROWSER_ENGINE_TOKEN='a'.repeat(64);
    const guard=createEngineGuard('owner');
    const app=Fastify();app.addHook('preHandler',guard.preHandler);
    app.get('/s/:sid/a/:token',async()=>({ok:true}));
    try {
      for(const value of ['', 'b'.repeat(64), 'é'.repeat(64)]){
        const response=await app.inject({url:'/s/owner/a/token',headers:{'x-libre-engine-token':value}});
        expect(response.statusCode).toBe(403);
      }
      expect((await app.inject({url:'/s/foreign/a/token',headers:{'x-libre-engine-token':'a'.repeat(64)}})).statusCode).toBe(403);
      expect((await app.inject({url:'/s/owner/a/token',headers:{'x-libre-engine-token':'a'.repeat(64)}})).statusCode).toBe(200);
    }finally{await app.close()}
  });
});
