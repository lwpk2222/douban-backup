import scrapyDouban from '../src/handle-douban';
import { ItemCategory } from '../src/types';
const data = await scrapyDouban('https://movie.douban.com/subject/37068446/', ItemCategory.Movie);
for (const key of ['电影/电视剧/番组', '上映年份', '海报', '类型', '制片国家/地区', '片长', '豆瓣评分']) {
  const value = data[key];
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) throw new Error('Missing live detail field: ' + key);
}
console.log('LIVE_DETAIL_VERIFIED ' + JSON.stringify(data));
