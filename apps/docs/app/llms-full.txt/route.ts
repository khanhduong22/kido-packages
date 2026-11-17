import { docsLlms } from '@/lib/source';
import { KIDO_BAG_LLMS_PREAMBLE } from '@/lib/llms-preamble';

export const revalidate = false;

export async function GET() {
  const generatedFull = await docsLlms.full();
  const body = `${KIDO_BAG_LLMS_PREAMBLE}\n\n---\n\n## 📚 Fumadocs Complete Documentation Pages\n\n${generatedFull}`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000',
    },
  });
}
