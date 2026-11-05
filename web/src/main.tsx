import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Tooltip } from 'radix-ui';

import App from './App';
import { Router } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Switching pages used to refetch everything the target page reads, even
      // data fetched two seconds earlier on the page just left: with the
      // default `staleTime` of 0 every value is stale the instant it lands, so
      // every mount refetches. Two seconds is shorter than every poll interval
      // in the console, so live data is unaffected — it only stops a navigation
      // from being a round trip.
      staleTime: 2000,
      // Long enough that leaving a page and coming back reads the cache instead
      // of showing "正在读取…" again. The default is five minutes, which is
      // easily exceeded while watching a run.
      gcTime: 30 * 60 * 1000,
    },
    mutations: { retry: 0 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={350}>
        <Router>
          <App />
        </Router>
      </Tooltip.Provider>
    </QueryClientProvider>
  </React.StrictMode>,
);
