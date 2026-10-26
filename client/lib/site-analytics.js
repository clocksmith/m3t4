// Shared entrypoint for pages outside the historical arena router.
import { initAnalytics, trackPageView } from './analytics.js';
initAnalytics();
trackPageView(location.pathname);
