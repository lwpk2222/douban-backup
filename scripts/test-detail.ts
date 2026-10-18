import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { solveDoubanPoW, parseDoubanDetail } from '../src/handle-douban';
import { ItemCategory } from '../src/types';
const link = 'https://movie.douban.com/subject/37068446/';
const html = '<form id="sec"><input id="tok" value="test-token"><input id="cha" value="test-challenge"><input id="red" value="' + link + '"></form><script>sha512</script>';
const payload = solveDoubanPoW(html, link);
assert.ok(createHash('sha512').update(payload.cha + payload.sol).digest('hex').startsWith('0000'));
assert.throws(() => solveDoubanPoW(html.replace(link, 'https://example.com/'), link), /unsupported/);
assert.throws(() => solveDoubanPoW('<form id="sec">CAPTCHA</form>', link), /unsupported/);
const doc = new JSDOM('<div id="content"><h1><span property="v:itemreviewed">测试 Film</span><span class="year">(2026)</span></h1></div><div id="mainpic"><img title="点击看更多海报" src="https://img2.doubanio.com/test.jpg"></div><div id="info"><span class="pl">导演</span><span>A</span><br><span property="v:genre">科幻</span><span property="v:genre">惊悚</span><br><span class="pl">制片国家/地区:</span>德国 / 法国 / 美国<br><span property="v:runtime">94分钟</span></div><strong property="v:average">7.3</strong>').window.document;
const movie = parseDoubanDetail(doc, ItemCategory.Movie) as Record<string, any>;
assert.equal(movie['电影/电视剧/番组'], '测试 Film');
assert.equal(movie['上映年份'], '2026');
assert.deepEqual(movie['类型'], ['科幻', '惊悚']);
assert.equal(movie['制片国家/地区'], '德国');
assert.equal(movie['片长'], '94分钟');
assert.equal(movie['豆瓣评分'], 7.3);
assert.equal(movie['海报'], 'https://img2.doubanio.com/test.jpg');
console.log('PoW safety boundaries and complete movie field extraction passed.');

const { missingDetailPatch } = await import('../src/handle-notion');
const existing = { properties: {
  '电影名': {type:'title', title:[{text:{content:'已有标题 (2026)'}}]},
  '封面': {type:'files',files:[{name:'uploaded',type:'file',file:{url:'https://notion.example/image'}}]},
  '类型': {type:'multi_select',multi_select:[]},
  '片长': {type:'rich_text',rich_text:[]},
  '豆瓣评分': {type:'number',number:0},
  '状态': {type:'select',select:{name:'想看'}},
  '个人评分': {type:'select',select:{name:'⭐⭐⭐⭐⭐'}},
  '我的短评': {type:'rich_text',rich_text:[{text:{content:'keep'}}]},
}};
const patch = missingDetailPatch({
  '电影名':{title:[{text:{content:'Remote (2026)'}}]},
  '封面':{files:[{external:{url:'https://remote.example/image'}}]},
  '类型':{multi_select:[{name:'科幻'}]},
  '片长':{rich_text:[{text:{content:'94分钟'}}]},
  '豆瓣评分':{number:7.3},
  '状态':{select:{name:'看过'}},
  '个人评分':{select:{name:'⭐'}},
  '我的短评':{rich_text:[]},
},existing);
assert.deepEqual(Object.keys(patch).sort(),['片长','类型'].sort());
assert.ok(missingDetailPatch({'电影名':{title:[{text:{content:'标题 (2026)'}}]}},
  {properties:{'电影名':{type:'title',title:[{text:{content:'标题'}}]}}})['电影名']);
console.log('Enrichment preserves titles with years, personal annotations and existing covers; fills only missing metadata.');

const { uploadPoster } = await import('../src/handle-notion');
const requests: Array<{url:string,init:any}> = [];
const mockFetch: typeof fetch = async (url: any, init?: any) => {
  requests.push({url:String(url),init});
  if (requests.length === 1) return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
  if (requests.length === 2) return Response.json({id:'test-upload-id'});
  return Response.json({status:'uploaded'});
};
const managed = await uploadPoster('https://img2.doubanio.com/test.jpg',mockFetch);
assert.deepEqual(managed,{type:'file_upload',file_upload:{id:'test-upload-id'}});
assert.equal(requests[0].init.headers.Referer,'https://movie.douban.com/');
assert.ok(requests[2].init.body instanceof FormData);
await assert.rejects(uploadPoster('https://example.com/a.jpg',mockFetch),/Unsupported/);
await assert.rejects(uploadPoster('https://img2.doubanio.com/a.jpg',async () => new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}})),/not an image/);
console.log('Managed image upload multipart flow and invalid-image rejection passed.');
