import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { toast } from "sonner";
import "./index.css";
import { App } from "./App";
import { ApiError } from "./lib/api";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 5_000, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
  },
  mutationCache: new MutationCache({
    onError: (e, _v, _c, m) => {
      if (!m.options.onError) toast.error((e as Error).message);
    },
  }),
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
