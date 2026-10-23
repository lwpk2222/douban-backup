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

const { rssMarkPatch } = await import('../src/handle-notion');
const markPage = {properties:{
  '状态':{type:'select',select:{name:'想看'}},
  '观影日期':{type:'date',date:null},
  '个人评分':{type:'select',select:null},
  '我的短评':{type:'rich_text',rich_text:[]},
  '封面':{type:'files',files:[{type:'file',file:{url:'keep'}}]},
}};
const markFeed:any={category:ItemCategory.Movie,status:'complete',time:'2026-10-23T15:16:39Z',rating:5,comment:'new review'};
const markPatch=rssMarkPatch(markFeed,markPage);
assert.equal(markPatch['状态'].select.name,'看过');
assert.equal(markPatch['个人评分'].select.name,'⭐⭐⭐⭐⭐');
assert.equal(markPatch['观影日期'].date.start,'2026-10-23');
assert.equal(markPatch['我的短评'].rich_text[0].text.content,'new review');
assert.deepEqual(Object.keys(markPatch).sort(),['状态','个人评分','观影日期','我的短评'].sort());
const synced:any={properties:{...markPage.properties,...Object.fromEntries(Object.entries(markPatch).map(([name,value]:any)=>[name,{type:Object.keys(value)[0],...value}]))}};
assert.deepEqual(rssMarkPatch(markFeed,synced),{});
assert.deepEqual(rssMarkPatch({...markFeed,time:'2026-10-22T15:16:39Z',status:'wishlist'},synced),{});
assert.equal(rssMarkPatch({...markFeed,rating:null},synced)['个人评分'].select,null);
assert.equal(rssMarkPatch({...markFeed,comment:''},synced)['我的短评'].rich_text.length,0);
console.log('Existing wishlist-to-watched updates, idempotency, stale RSS protection and removed marks passed.');

const { matchMovieDraft } = await import('../src/handle-notion');
const draft=(id:string,title:string)=>({id,properties:{'电影名':{type:'title',title:[{text:{content:title}}]}}});
const manual=draft('manual',' 再次出发之纽约遇见你 ');
assert.equal(matchMovieDraft([manual],'再次出发之纽约遇见你','再次出发之纽约遇见你 Begin Again',2013).page?.id,'manual');
assert.equal(matchMovieDraft([draft('year','Begin Again (2013)')],'再次出发之纽约遇见你','Begin Again',2013).page?.id,'year');
assert.equal(matchMovieDraft([draft('wrong','Begin Again (2020)')],'再次出发之纽约遇见你','Begin Again',2013).page,undefined);
assert.equal(matchMovieDraft([manual,draft('duplicate','再次出发之纽约遇见你')],'再次出发之纽约遇见你','Begin Again',2013).ambiguous,true);
assert.equal(matchMovieDraft([draft('substring','再次出发')],'再次出发之纽约遇见你','Begin Again',2013).page,undefined);
assert.equal(matchMovieDraft([draft('empty','')],'','',2013).page,undefined);
assert.equal(matchMovieDraft([draft('unicode','ＢＥＧＩＮ　ＡＧＡＩＮ （２０１３）')],'Begin Again','Begin Again',2013).page?.id,'unicode');
console.log('Unique exact movie draft matching, year conflicts, duplicate ambiguity and no fuzzy matches passed.');

for (const name of ['Fleabag S01','Fleabag Season 1','伦敦生活 第一季','伦敦生活 第1季','伦敦生活','Fleabag']) {
  assert.equal(matchMovieDraft([draft('alias',name)],'伦敦生活 第一季','伦敦生活 第一季 Fleabag Season 1',2016).page?.id,'alias',name);
}
assert.equal(matchMovieDraft([draft('wrong-season','Fleabag S02')],'伦敦生活 第一季','伦敦生活 第一季 Fleabag Season 1',2016).page,undefined);
assert.equal(matchMovieDraft([draft('season-only','第一季')],'伦敦生活 第一季','伦敦生活 第一季 Fleabag Season 1',2016).page,undefined);
assert.equal(matchMovieDraft([draft('short','伦敦')],'伦敦生活 第一季','伦敦生活 第一季 Fleabag Season 1',2016).page,undefined);
assert.equal(matchMovieDraft([draft('cn','伦敦生活 第一季'),draft('en','Fleabag S01')],'伦敦生活 第一季','伦敦生活 第一季 Fleabag Season 1',2016).ambiguous,true);
assert.equal(matchMovieDraft([draft('bad-year','Fleabag S01 (2019)')],'伦敦生活 第一季','伦敦生活 第一季 Fleabag Season 1',2016).page,undefined);
assert.equal(matchMovieDraft([draft('twelfth','Example S12')],'示例 第十二季','示例 第十二季 Example Season 12',2026).page?.id,'twelfth');
assert.equal(matchMovieDraft([draft('unscoped','Fleabag S01')],'Fleabag','Fleabag',2016).page,undefined);
assert.equal(matchMovieDraft([draft('conflicting','Fleabag S01 Season 2')],'Fleabag Season 1','Fleabag Season 1',2016).page,undefined);
console.log('Bilingual aliases and Chinese/Season/S01 notation passed; season/year conflicts and ambiguous drafts rejected.');

const recordDatePage:any={properties:{...markPage.properties,'记录日期':{type:'date',date:null}}};
delete recordDatePage.properties['观影日期'];
const wishlistMark=rssMarkPatch({...markFeed,status:'wishlist',time:'2026-10-20T10:00:00Z'},recordDatePage);
assert.equal(wishlistMark['记录日期'].date.start,'2026-10-20');
assert.equal(wishlistMark['观影日期'],undefined);
recordDatePage.properties['记录日期'].date={start:'2026-10-20'};
assert.equal(rssMarkPatch(markFeed,recordDatePage)['记录日期'].date.start,'2026-10-23');
console.log('Shared record date tracks wishlist and watched marks using the renamed movie field.');
