
import { Client } from '@notionhq/client';
import { uploadPoster } from '../src/handle-notion';
const notion = new Client({auth:process.env.NOTION_TOKEN,notionVersion:'2025-09-03'});
const pageId='3fc910b6-dda9-814a-89a8-dea8e165496f';
const page:any=await notion.pages.retrieve({page_id:pageId});
if(page.cover?.type==='file' && page.properties['封面']?.files?.[0]?.type==='file'){
  console.log('MANAGED_POSTER_VERIFIED already stored in Notion');
}else{
  const cover=await uploadPoster('https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2936442661.jpg');
  await notion.pages.update({page_id:pageId,cover,properties:{'封面':{files:[{name:'生化危机：爆发夜.jpg',...cover}]}}});
  const verified:any=await notion.pages.retrieve({page_id:pageId});
  if(verified.cover?.type!=='file'||verified.properties['封面']?.files?.[0]?.type!=='file')throw new Error('Poster is still external');
  console.log('MANAGED_POSTER_VERIFIED page cover and gallery image are Notion files');
}
