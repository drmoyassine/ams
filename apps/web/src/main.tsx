import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './index.css';
import { applyDocumentLocale, readLocaleHint } from './lib/language';
import { queryClient, router } from './router';

// First paint: the direction and script of the language this browser used last, so the page does not flip when the server's
// answer arrives. Only a hint: the signed-in person's own setting (or the institution's default) always overrides it.
const hint = readLocaleHint();
if (hint) applyDocumentLocale(hint);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
