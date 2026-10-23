import { consola } from 'consola';
import dayjs from 'dayjs';
import dotenv from 'dotenv';
import { Client, type DatabaseObjectResponse } from '@notionhq/client';
import { type CreatePageParameters } from '@notionhq/client/build/src/api-endpoints';
import scrapyDouban from './handle-douban';
import { getDataSourceId, sleep, buildPropertyValue } from './utils';
import { EMOJI } from './const';
import DB_PROPERTIES from '../cols.json';
import {
  ItemCategory,
  type FeedItem,
  type NotionUrlPropType,
  type FailedItem,
} from './types';

// https://github.com/makenotion/notion-sdk-js/issues/280#issuecomment-1178523498
type EmojiRequest = Extract<CreatePageParameters['icon'], { type?: 'emoji'; }>['emoji'];

function movieTitleWithYear(title: string, year: unknown): string {
  const match = String(year ?? '').trim().match(/^(\d{4})(?:\.0)?$/);
  if (!match) return title;
  const suffix = ` (${match[1]})`;
  const cleanTitle = title.trimEnd();
  return cleanTitle.endsWith(suffix) ? cleanTitle : cleanTitle + suffix;
}


export function missingDetailPatch(properties: Record<string, any>, existing: any): Record<string, any> {
  const patch: Record<string, any> = {};
  const personal = new Set(['个人评分', '评分', '我的短评', '状态', '观影日期', '观影时间', '阅读日期', '阅读时间', '豆瓣链接', DB_PROPERTIES.ITEM_LINK]);
  for (const [name, value] of Object.entries(properties)) {
    if (personal.has(name)) continue;
    const current = existing.properties[name];
    const raw = current?.[current.type];
    const missing = raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0);
    const titleNeedsYear = name === '电影名' && !/\(\d{4}\)$/.test(
      (current?.title || []).map((t: any) => t.plain_text || t.text?.content || '').join('')
    );
    if (missing || titleNeedsYear) patch[name] = value;
  }
  return patch;
}



/** Douban owns mark properties; page body and uploaded files are never touched here. */
export function rssMarkPatch(feed: FeedItem, existing: any): Record<string, any> {
  const movie = feed.category === ItemCategory.Movie;
  if (!movie && feed.category !== ItemCategory.Book) return {};
  const props = existing.properties;
  const dateName = (movie ? ['观影日期', '观影时间'] : ['阅读日期', '阅读时间'])
    .find(name => props[name]?.type === 'date');
  const incomingDate = dayjs(feed.time).format('YYYY-MM-DD');
  if (!dayjs(feed.time).isValid()) throw new Error('Invalid RSS mark date');
  const currentDate = dateName ? props[dateName]?.date?.start?.slice(0, 10) : null;
  // An older cached RSS mark must not roll back a newer Notion mark.
  if (currentDate && incomingDate < currentDate) return {};
  const states = movie ? ['想看', '在看', '看过'] : ['想读', '在读', '读过'];
  const patch: Record<string, any> = {};
  const state = states[feed.status === 'wishlist' ? 0 : feed.status === 'progress' ? 1 : 2];
  if (props['状态']?.type === 'select' && props['状态'].select?.name !== state)
    patch['状态'] = { select: { name: state } };
  if (dateName && currentDate !== incomingDate) patch[dateName] = {date:{start:incomingDate}};
  const ratingName = ['个人评分', '评分'].find(name => props[name]?.type === 'select');
  const rating = Number(feed.rating);
  const stars = Number.isInteger(rating) && rating >= 1 && rating <= 5 ? '⭐'.repeat(rating) : null;
  if (ratingName && (props[ratingName].select?.name || null) !== stars)
    patch[ratingName] = {select: stars ? {name:stars} : null};
  const comment = feed.comment || '';
  const currentComment = (props['我的短评']?.rich_text || []).map((t:any) => t.plain_text || t.text?.content || '').join('');
  if (props['我的短评']?.type === 'rich_text' && currentComment !== comment) {
    patch['我的短评'] = {rich_text: comment ? Array.from({length:Math.ceil(comment.length / 2000)}, (_,i) =>
      ({type:'text',text:{content:comment.slice(i*2000,(i+1)*2000)}})) : []};
  }
  return patch;
}


function titleParts(value: string): {name:string;year:string|null} {
  const normalized = value.normalize('NFKC').trim();
  const year = normalized.match(/\((\d{4})\)$/)?.[1] || null;
  return {name:normalized.replace(/\s*\(\d{4}\)$/, '').replace(/\s+/g,'').toLocaleLowerCase(),year};
}

/** Exact title matching only, never fuzzy/substring matching. */
export function matchMovieDraft(pages: any[], title: string, detailTitle: string, year: unknown,
  titleProperty = '电影名'): {page?:any;ambiguous:boolean} {
  const names = new Set([titleParts(title).name,titleParts(detailTitle).name].filter(Boolean));
  const sourceYear = String(year || '').match(/\d{4}/)?.[0] || titleParts(detailTitle).year;
  const matches = pages.filter(page => {
    const p=page.properties[titleProperty];
    const raw=(p?.title || []).map((t:any)=>t.plain_text || t.text?.content || '').join('');
    const draft=titleParts(raw);
    return draft.name && names.has(draft.name) && (!draft.year || draft.year === sourceYear);
  });
  return matches.length === 1 ? {page:matches[0],ambiguous:false} : {ambiguous:matches.length>1};
}

export async function uploadPoster(url: string, request: typeof fetch = fetch) {
  const source = new URL(url);
  if (source.protocol !== 'https:' || !/(^|\.)doubanio\.com$/.test(source.hostname)) {
    throw new Error('Unsupported poster source');
  }
  const response = await request(url, {
    headers: { Referer: 'https://movie.douban.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Poster download HTTP ' + response.status);
  const contentType = response.headers.get('content-type')?.split(';')[0] || '';
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
    throw new Error('Poster response is not an image');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) throw new Error('Poster size invalid');
  const suffix = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1];
  const filename = 'douban-poster.' + suffix;
  const headers = { Authorization: 'Bearer ' + process.env.NOTION_TOKEN, 'Notion-Version': '2025-09-03' };
  const created = await request('https://api.notion.com/v1/file_uploads', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'single_part', filename, content_type: contentType }),
    signal: AbortSignal.timeout(30000),
  });
  if (!created.ok) throw new Error('Notion upload creation HTTP ' + created.status);
  const upload = await created.json() as { id: string };
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);
  const sent = await request('https://api.notion.com/v1/file_uploads/' + upload.id + '/send', {
    method: 'POST', headers, body: form, signal: AbortSignal.timeout(30000),
  });
  if (!sent.ok) throw new Error('Notion poster upload HTTP ' + sent.status);
  const uploaded = await sent.json() as { status: string };
  if (uploaded.status !== 'uploaded') throw new Error('Notion poster upload not complete');
  return { type: 'file_upload' as const, file_upload: { id: upload.id } };
}

function externalPoster(page: any): string | undefined {
  return page.properties['封面']?.files?.find((file: any) => file.type === 'external')?.external?.url;
}


dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: '2025-09-03',
});

/**
 * Asynchronously handles the Notion feeds by grouping them by category and then
 * syncing the categorized feeds to the Notion database as one category corresponding
 * to one Notion database.
 *
 * @param {FeedItem[]} feeds - The array of feed items to be handled
 * @return {Promise<void>} A promise that resolves when all feeds are synced to
 * the Notion database
 */
export default async function handleNotion(feeds: FeedItem[]): Promise<void> {
  const groupByCategory: Partial<Record<ItemCategory, FeedItem[]>> = feeds.reduce(
    (acc, feed) => {
      if (!acc[feed.category]) {
        acc[feed.category] = [];
      }
      acc[feed.category]!.push(feed);
      return acc;
    },
    {} as Partial<Record<ItemCategory, FeedItem[]>>,
  );

  const AllFailedItems: FailedItem[] = [];

  for (const category in groupByCategory) {
    try {
      const categorizedFeeds = groupByCategory[category as ItemCategory] as FeedItem[];
      const failed = await syncNotionDB(categorizedFeeds, category as ItemCategory);
      if (failed) {
        AllFailedItems.push(...failed);
      }
    } catch (error) {
      consola.error(`Failed to handle ${category} feeds. `, error);
      process.exit(1);
    }
  }

  if (AllFailedItems.length) {
    consola.warn('Failed to handle the following feeds to insert into Notion:');
    for (const item of AllFailedItems) {
      consola.warn(`${item.title}: ${item.link}`);
    }
    process.exit(1);
  }
}

/**
 * Asynchronously synchronizes the Notion database with categorized feeds.
 *
 * @param {FeedItem[]} categorizedFeeds - the array of categorized feed items
 * @param {ItemCategory} category - the category of the feed items
 * @return {Promise<FailedItem[] | undefined>} an array of failed items or undefined
 */
async function syncNotionDB(categorizedFeeds: FeedItem[], category: ItemCategory): Promise<FailedItem[] | undefined> {
  if (categorizedFeeds.length === 0) {
    consola.info(`No new ${category} feeds.`);
    return;
  }

  const dataSourceId = getDataSourceId(category);
  if (!dataSourceId) {
    consola.warn(`No notion data source id for ${category}`);
    return;
  }

  consola.start(`Handling ${category} feeds...`);

  const sourceSchema = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  const itemLinkProperty = sourceSchema.properties['豆瓣链接'] ? '豆瓣链接' : DB_PROPERTIES.ITEM_LINK;

  // after @notionhq sdk upgraded to v5.0.0, use dataSource instead of database
  const queryItems = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: {
      or: categorizedFeeds.map((item) => ({
        property: itemLinkProperty,
        url: {
          contains: item.id,
        },
      })),
    },
  }).catch((error) => {
    consola.error(`Failed to query ${category} database to check already inserted items. `, error);
    process.exit(1);
  });

  const existingPages = new Map<string, any>();
  for (const page of queryItems.results) {
    if ('properties' in page) {
      const link = (page.properties[itemLinkProperty] as NotionUrlPropType).url;
      if (link) existingPages.set(link.replace(/^http:/, 'https:'), page);
    }
  }
  const draftPages: any[] = [];
  const draftTitleProperty = sourceSchema.properties['电影名'] ? '电影名' : DB_PROPERTIES.MOVIE_TITLE;
  if (category === ItemCategory.Movie && categorizedFeeds.some(item => !existingPages.has(item.link.replace(/^http:/,'https:')))) {
    let cursor: string | undefined;
    do {
      const result = await notion.dataSources.query({
        data_source_id:dataSourceId,
        filter:{property:itemLinkProperty,url:{is_empty:true}},
        page_size:100, ...(cursor ? {start_cursor:cursor} : {}),
      });
      draftPages.push(...result.results.filter(page => 'properties' in page));
      cursor = result.has_more ? result.next_cursor || undefined : undefined;
    } while (cursor);
  }
  const claimedDraftIds = new Set<string>();
  const empty = (property: any): boolean => !property ||
    property[property.type] == null ||
    (Array.isArray(property[property.type]) && property[property.type].length === 0) ||
    property[property.type] === '';
  const needsDetails = (page: any): boolean => {
    if (category === ItemCategory.Movie) {
      const title = page.properties['电影名']?.title?.map((t: any) => t.plain_text || t.text?.content || '').join('') || '';
      return !/\(\d{4}\)$/.test(title) || ['类型', '制片国家/地区', '片长', '豆瓣评分']
        .some(name => sourceSchema.properties[name] && empty(page.properties[name]));
    }
    return category === ItemCategory.Book && ['作者', '页数', '豆瓣评分']
      .some(name => sourceSchema.properties[name] && empty(page.properties[name]));
  };
  const newFeeds = categorizedFeeds.filter(item => {
    const page = existingPages.get(item.link.replace(/^http:/, 'https:'));
    return !page || Object.keys(rssMarkPatch(item, page)).length > 0 || !!externalPoster(page) || (process.env.DOUBAN_RSS_ONLY !== 'true' && needsDetails(page));
  });
  consola.info(`There are total ${newFeeds.length} new or incomplete ${category} item(s) to sync.`);

  const failedItems: FailedItem[] = [];

  for (const newFeedItem of newFeeds) {
    try {
      const currentPage = existingPages.get(newFeedItem.link.replace(/^http:/, 'https:'));
      // Cover-only repairs do not request the detail page again.
      let itemData: Record<string, string | string[] | number | null | undefined>;
      if (process.env.DOUBAN_RSS_ONLY === 'true' || (currentPage && !needsDetails(currentPage))) {
        if (!newFeedItem.title) throw new Error('RSS item has no usable title: ' + newFeedItem.link);
        const titleKey = category === ItemCategory.Movie ? DB_PROPERTIES.MOVIE_TITLE
          : category === ItemCategory.Book ? DB_PROPERTIES.BOOK_TITLE
          : category === ItemCategory.Music ? DB_PROPERTIES.MUSIC_TITLE
          : category === ItemCategory.Game ? DB_PROPERTIES.GAME_TITLE : DB_PROPERTIES.DRAMA_TITLE;
        itemData = {
          [DB_PROPERTIES.NAME]: newFeedItem.title,
          [titleKey]: newFeedItem.title,
          [category === ItemCategory.Movie ? DB_PROPERTIES.POSTER : DB_PROPERTIES.COVER]: externalPoster(currentPage || {properties:{}}) || newFeedItem.cover,
        };
        consola.info('Using RSS metadata only; detail-only fields remain empty.');
      } else {
        itemData = await scrapyDouban(newFeedItem.link, category);
      }
      itemData[DB_PROPERTIES.ITEM_LINK] = newFeedItem.link;
      itemData[DB_PROPERTIES.RATING] = newFeedItem.rating;
      itemData[DB_PROPERTIES.RATING_DATE] = dayjs(newFeedItem.time).format('YYYY-MM-DD');
      itemData[DB_PROPERTIES.COMMENTS] = newFeedItem.comment;
      if (category === ItemCategory.Movie || category === ItemCategory.Book) {
        const states = category === ItemCategory.Movie ? ['想看', '在看', '看过'] : ['想读', '在读', '读过'];
        itemData['状态'] = states[newFeedItem.status === 'wishlist' ? 0 : newFeedItem.status === 'progress' ? 1 : 2];
      }
      let existing = existingPages.get(newFeedItem.link.replace(/^http:/, 'https:'));
      if (!existing && category === ItemCategory.Movie && draftPages.length) {
        const draft = matchMovieDraft(draftPages, newFeedItem.title || '',
          String(itemData[DB_PROPERTIES.MOVIE_TITLE] || ''), itemData[DB_PROPERTIES.YEAR], draftTitleProperty);
        if (draft.ambiguous || (draft.page && claimedDraftIds.has(draft.page.id))) {
          consola.warn('Ambiguous manual movie title; fill its Douban link to resolve: ' + newFeedItem.title);
          failedItems.push({link:newFeedItem.link,title:newFeedItem.title || newFeedItem.id});
          continue;
        }
        existing = draft.page;
        if (existing) {
          claimedDraftIds.add(existing.id);
          consola.info('Matched manual movie draft by exact title: ' + newFeedItem.title);
        }
      }
      const successful = await addItemToNotion(itemData, category, existing, newFeedItem);
      if (!successful) {
        failedItems.push({
          link: newFeedItem.link,
          title: itemData.title as string,
        });
      }
      await sleep(10000);

    } catch (error) {
      consola.error(error);
      failedItems.push({ link: newFeedItem.link, title: newFeedItem.title || newFeedItem.id });
      const statusCode = (error as { response?: { statusCode?: number } })?.response?.statusCode;
      if ([403, 418, 429].includes(statusCode || 0) ||
          (error instanceof Error && error.message.includes('Douban access restriction'))) throw error;
      continue;
    }
  }

  if (failedItems.length) {
    consola.error(`Failed to insert ${failedItems.length} items into ${category} Notion database.`);
  }
  consola.success(`${category} feeds done.`);
  consola.log('====================');
  return failedItems;
}

/**
 * Insert an item to Notion database.
 *
 * @param {object} itemData - The data of the item to be added to the Notion database.
 * @param {ItemCategory} category - The category of the item.
 * @return {boolean} Indicates whether the item was successfully added to the database.
 */
async function addItemToNotion(itemData: {
    [key: string]: string | string[] | number | null | undefined;
}, category: ItemCategory, existing?: any, feed?: FeedItem): Promise<boolean> {
  consola.start(
    'Going to insert ',
    itemData[DB_PROPERTIES.RATING_DATE],
    itemData[DB_PROPERTIES.NAME]
  );
  try {
    const dataSourceId = getDataSourceId(category);
    if (!dataSourceId) throw new Error('No data source id found for category: ' + category);
    const db = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
    const columns = Object.keys(db.properties);
    const aliases: Record<string, string[]> = {
      [DB_PROPERTIES.MOVIE_TITLE]: ['电影名'],
      [DB_PROPERTIES.YEAR]: ['年份'],
      [DB_PROPERTIES.POSTER]: ['封面'],
      [DB_PROPERTIES.ITEM_LINK]: ['豆瓣链接'],
      [DB_PROPERTIES.RATING]: ['个人评分', '评分'],
      [DB_PROPERTIES.RATING_DATE]: category === ItemCategory.Movie
        ? ['观影日期', '观影时间'] : category === ItemCategory.Book ? ['阅读日期', '阅读时间'] : [],
    };
    const properties: Record<string, any> = {};
    for (const [original, value] of Object.entries(itemData)) {
      if (value === null || value === undefined || value === '') continue;
      const target = (aliases[original] || []).find(name => columns.includes(name)) || original;
      const property = db.properties[target];
      if (!property) continue;
      if (property.type === 'select') {
        let name = String(value);
        if (original === DB_PROPERTIES.RATING) {
          const score = Number(value);
          if (!Number.isInteger(score) || score < 1 || score > 5) continue;
          name = '⭐'.repeat(score);
        } else if (target === '制片国家/地区') {
          name = name.split(/[\/／]/)[0].trim();
        }
        if (name) properties[target] = { select: { name } };
      } else {
        properties[target] = buildPropertyValue(
          category === ItemCategory.Movie && original === DB_PROPERTIES.MOVIE_TITLE
            ? movieTitleWithYear(String(value), itemData[DB_PROPERTIES.YEAR]) : value,
          property.type as Parameters<typeof buildPropertyValue>[1],
          original === DB_PROPERTIES.RATING ? DB_PROPERTIES.RATING : target
        );
      }
    }

    const coverName = columns.includes('封面') ? '封面' : DB_PROPERTIES.POSTER;
    const sourcePoster = properties[coverName]?.files?.[0]?.external?.url;
    const currentFiles = existing?.properties[coverName]?.files || [];
    let uploadedCover: Awaited<ReturnType<typeof uploadPoster>> | undefined;
    if (sourcePoster && (!existing || currentFiles.length === 0 || externalPoster(existing))) {
      uploadedCover = await uploadPoster(sourcePoster);
      properties[coverName] = { files: [{ name: '豆瓣封面', ...uploadedCover }] };
    }

    if (existing) {
      // Preserve existing uploaded files; migrate fragile external poster URLs.

      const patch = { ...missingDetailPatch(properties, existing), ...(feed ? rssMarkPatch(feed, existing) : {}) };
      const linkName = columns.includes('豆瓣链接') ? '豆瓣链接' : DB_PROPERTIES.ITEM_LINK;
      if (!existing.properties[linkName]?.url && properties[linkName]) patch[linkName] = properties[linkName];
      if (uploadedCover) patch[coverName] = properties[coverName];
      if (Object.keys(patch).length) {
        await notion.pages.update({ page_id: existing.id, properties: patch, ...(uploadedCover ? {cover:uploadedCover} : {}) });
        consola.success('Enriched existing item: ' + itemData[DB_PROPERTIES.NAME] + ' fields=' + Object.keys(patch).join(','));
      }
      return true;
    }

    const postData: CreatePageParameters = {
      parent: {
        type: "data_source_id",
        data_source_id: dataSourceId,
      },
      icon: {
        type: 'emoji',
        emoji: EMOJI[category] as EmojiRequest,
      },
      // fill in properties by the format: https://developers.notion.com/reference/page#page-property-value
      properties,
    };

    if (uploadedCover) postData.cover = uploadedCover;

    if ((category === ItemCategory.Movie || category === ItemCategory.Book) &&
        !db.properties[DB_PROPERTIES.COMMENTS] && itemData[DB_PROPERTIES.COMMENTS]) {
      const comment = String(itemData[DB_PROPERTIES.COMMENTS]);
      postData.children = [{
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: Array.from({ length: Math.ceil(comment.length / 2000) }, (_, i) => ({
            type: 'text' as const,
            text: { content: comment.slice(i * 2000, (i + 1) * 2000) },
          })),
        },
      }];
    }

    const response = await notion.pages.create(postData);
    if (response && response.id) {
      consola.success(
        itemData[DB_PROPERTIES.NAME] +
          `[${itemData[DB_PROPERTIES.ITEM_LINK]}]` +
          ' page inserted into Notion database.'
      );
    }
    return true;
  } catch (error) {
    consola.error(
      'Failed to create ' +
        itemData[DB_PROPERTIES.NAME] +
        `(${itemData[DB_PROPERTIES.ITEM_LINK]})` +
        ' with error: ',
      error
    );
    return false;
  }
}
