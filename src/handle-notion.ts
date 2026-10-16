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

  const alreadyInsertedItems = new Set(queryItems.results.map((i) => {
    if ('properties' in i) {
      return (i.properties[itemLinkProperty] as NotionUrlPropType).url;
    }
    return;
  }).filter(v => v));

  const newFeeds = categorizedFeeds.filter((item) => {
    return !alreadyInsertedItems.has(item.link);
  });

  consola.info(`There are total ${newFeeds.length} new ${category} item(s) need to insert.`);

  const failedItems: FailedItem[] = [];

  for (const newFeedItem of newFeeds) {
    try {
      const itemData = await scrapyDouban(newFeedItem.link, category);
      itemData[DB_PROPERTIES.ITEM_LINK] = newFeedItem.link;
      itemData[DB_PROPERTIES.RATING] = newFeedItem.rating;
      itemData[DB_PROPERTIES.RATING_DATE] = dayjs(newFeedItem.time).format('YYYY-MM-DD');
      itemData[DB_PROPERTIES.COMMENTS] = newFeedItem.comment;
      if (category === ItemCategory.Movie || category === ItemCategory.Book) {
        const states = category === ItemCategory.Movie ? ['想看', '在看', '看过'] : ['想读', '在读', '读过'];
        itemData['状态'] = states[newFeedItem.status === 'wishlist' ? 0 : newFeedItem.status === 'progress' ? 1 : 2];
      }
      const successful = await addItemToNotion(itemData, category);
      if (!successful) {
        failedItems.push({
          link: newFeedItem.link,
          title: itemData.title as string,
        });
      }
      await sleep(1000);

    } catch (error) {
      consola.error(error);
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
}, category: ItemCategory): Promise<boolean> {
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
          value,
          property.type as Parameters<typeof buildPropertyValue>[1],
          original === DB_PROPERTIES.RATING ? DB_PROPERTIES.RATING : target
        );
      }
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

    if (properties[DB_PROPERTIES.POSTER] || properties[DB_PROPERTIES.COVER]) {
      // use poster for the page cover
      postData.cover = {
        type: 'external',
        external: {
          url: (properties[DB_PROPERTIES.POSTER] || properties[DB_PROPERTIES.COVER])?.files[0]?.external?.url, // cannot be empty string or null
        },
      };
    }

    if ((category === ItemCategory.Movie || category === ItemCategory.Book) && itemData[DB_PROPERTIES.COMMENTS]) {
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
