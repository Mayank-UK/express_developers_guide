import { Link } from 'react-router';
import { SectionWrapper } from '../../components/section-wrapper';
import { ContentGroupWrapper } from '../../components/content-group-wrapper';
import { TextBlock } from '../../components/text-block';
import { routePaths, topicPath } from '../../routing/routes';

/**
 * About — how this app is built and where it sits in the guide family. Every
 * claim here is deliberately verifiable against the repository as it exists
 * today; the screen grows as the app grows.
 */
export function AboutView() {
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-lg px-md py-xl">
      <header className="flex flex-col gap-sm">
        <h1 className="font-display text-display-sm text-on-surface">About this guide</h1>
        <p className="text-title-sm text-on-surface-variant">
          A working app that is the book.
        </p>
      </header>

      <SectionWrapper
        id="how-this-app-is-built"
        title="How this app is built"
        lead="The guide is not about a sample app — the guide IS the app you are looking at."
      >
        <ContentGroupWrapper title="One app, two packages">
          <TextBlock>
            {'This repository is a monorepo. The server/ package is an Express 5 + TypeScript API, and it carries 100% of the teaching: every topic, section, and code sample you read is served as typed, versioned JSON from its content API. The client/ package is a React shell that fetches that JSON and renders it — it owns no teaching content of its own.'}
          </TextBlock>
        </ContentGroupWrapper>
        <ContentGroupWrapper title="A layered server">
          <TextBlock>
            {'The server follows a strict layering: routes accept HTTP and stay thin, controllers parse and validate input, use cases hold the domain logic, repositories implement persistence behind domain ports, and the data layer owns the actual storage. The dependency rule is one-way — presentation depends on the domain, never the other way around — and a single error taxonomy turns every failure into one consistent JSON error envelope with a request id.'}
          </TextBlock>
        </ContentGroupWrapper>
        <ContentGroupWrapper title="Built for demonstrations">
          <TextBlock>
            {'Because the app is real, it can demonstrate its own lessons live. A runtime scenario toggle switches the data layer between fake (in-memory) and live (SQLite) implementations without restarting the process, and a failure-injection switch makes any endpoint fail on demand so you can watch the error pipeline respond. The status chips on the home page show both switches as they are right now.'}
          </TextBlock>
        </ContentGroupWrapper>
      </SectionWrapper>

      <SectionWrapper
        id="guide-family"
        title="The guide family"
        lead="Why the topic tree looks the way it does."
      >
        <TextBlock>
          {'This guide is a sibling of react_developers_guide, which teaches the React side of the stack the same way — as one working app. The topic tree you see in the navigation is a backend canon: the framework-agnostic concepts every backend engineer needs, ordered concept-first, then implemented in Express. The same tree is the pattern for planned Flask, FastAPI, and Spring Boot guides, so the same backend fundamentals can be learned against any of those frameworks.'}
        </TextBlock>
      </SectionWrapper>

      <SectionWrapper
        id="explore"
        title="Explore"
        lead="Start anywhere; the topic map is the full curriculum."
      >
        <div className="flex flex-col gap-sm sm:flex-row">
          <ExploreCard to={routePaths.home} title="Topic map" description="The home page: run instructions plus every topic, grouped." />
          <ExploreCard
            to={topicPath('express-fundamentals')}
            title="Express fundamentals"
            description="The first fully populated topic — and the reference for how every topic screen renders."
          />
        </div>
      </SectionWrapper>
    </div>
  );
}

function ExploreCard({ to, title, description }: { to: string; title: string; description: string }) {
  return (
    <Link
      to={to}
      className="flex flex-1 flex-col gap-xs rounded-md border border-outline bg-surface p-md shadow-button-card transition-colors hover:border-primary hover:bg-surface-variant"
    >
      <span className="font-display text-title-sm text-on-surface">{title}</span>
      <span className="text-body-sm text-on-surface-variant">{description}</span>
    </Link>
  );
}
