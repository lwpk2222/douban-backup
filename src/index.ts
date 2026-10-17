import { consola } from 'consola';
import { fetchRSSFeeds, handleRSSFeeds } from './handle-rss';
import handleNotion from './handle-notion';
import handleNeodb from './handle-neodb';

async function main(): Promise<void> {
  const feeds = await fetchRSSFeeds();
  if (feeds.length === 0) {
    consola.info('No new items.');
    return;
  }

  const normalizedFeeds = handleRSSFeeds(feeds);
  // Sync wishlist, progress and completed marks to their Notion status views.
  consola.info(`RSS returned ${feeds.length} items; ${normalizedFeeds.length} recognized marks.`);
  if (normalizedFeeds.length) {
    await handleNotion(normalizedFeeds);
  }

  await handleNeodb(normalizedFeeds);
}

main();
