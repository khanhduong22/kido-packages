import { docsLlms } from '@/lib/source';
import { KIDO_BAG_LLMS_PREAMBLE } from '@/lib/llms-preamble';

export const revalidate = false;

export async function GET() {
  const generatedIndex = await docsLlms.index();
  const body = `${KIDO_BAG_LLMS_PREAMBLE}\n\n---\n\n## 📚 Fumadocs Interactive Documentation Index\n\n${generatedIndex}`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000',
    },
  });
}
