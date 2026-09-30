import { useParams } from 'react-router';
import { SectionWrapper } from '../../components/section-wrapper';
import { TextBlock } from '../../components/text-block';
import { CodeBlock } from '../../components/code-block';
import { ErrorPanel } from '../../components/error-panel';
import { DemoHost } from '../../demos/demo_registry';
import type { ContentBlock } from '../../../domain/models/topic';
import { useHeaderTitle } from '../../hooks/use-header-title';
import { useTopic } from './topic_view.hooks';

/**
 * TopicView — the GENERIC topic screen: every topic served by the content API
 * renders through this one component (topic → sections → blocks). It owns no
 * content of its own; the server is the single source of teaching material and
 * this view just maps each block kind onto its presenter.
 */
export function TopicView() {
  const { topicId } = useParams<'topicId'>();
  const view = useTopic(topicId);

  // The header follows the served topic title once loaded; the route handle's
  // "Topic" covers loading, unknown, and failed topics.
  useHeaderTitle(view.state === 'ready' ? view.topic.title : undefined);

  if (view.state === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-lg px-md py-xl">
        <p data-testid="topic-loading" className="text-body text-on-surface-variant">
          loading topic…
        </p>
        <div className="h-lg w-full animate-pulse rounded-md bg-surface-variant" />
        <div className="h-lg w-2/3 animate-pulse rounded-md bg-surface-variant" />
      </div>
    );
  }

  if (view.state === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-lg px-md py-xl">
        <ErrorPanel subject="this topic" failure={view.failure} />
      </div>
    );
  }

  const { topic } = view;

  return (
    <article className="mx-auto flex w-full max-w-content flex-col gap-lg px-md py-xl">
      <header className="flex flex-col gap-sm">
        <h1 className="font-display text-display-sm text-on-surface">{topic.title}</h1>
        {topic.subtitle !== undefined && (
          <p className="text-title-sm text-on-surface-variant">{topic.subtitle}</p>
        )}
      </header>

      {topic.sections.map((section) => (
        <SectionWrapper key={section.id} id={section.id} title={section.title} lead={section.lead}>
          {section.blocks.map((block) => (
            <TopicBlock key={block.id} block={block} />
          ))}
        </SectionWrapper>
      ))}
    </article>
  );
}

function TopicBlock({ block }: { block: ContentBlock }) {
  switch (block.kind) {
    case 'text':
      return <TextBlock>{block.body}</TextBlock>;
    case 'code':
      return <CodeBlock code={block.code} language={block.language} caption={block.caption} />;
    case 'demo':
      return <DemoHost demoId={block.demoId} title={block.title} description={block.description} />;
  }
}
