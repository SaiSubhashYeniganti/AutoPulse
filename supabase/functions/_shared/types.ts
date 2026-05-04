// Shared types across all Edge Functions.

export type Bucket = "COMPETITOR" | "MARKET" | "CARS24_PRESS" | "CARS24_PR" | null;
export type Importance = "HIGH" | "MED" | "LOW" | "DROP";
// The 5 tracked competitors. null = MARKET / general / non-tracked-competitor story.
export type PrimaryCompetitor =
  | "Cars24"
  | "Spinny"
  | "CarDekho"
  | "Droom"
  | "OLX Autos"
  | null;
export const TRACKED_COMPETITORS: ReadonlyArray<Exclude<PrimaryCompetitor, null>> = [
  "Cars24",
  "Spinny",
  "CarDekho",
  "Droom",
  "OLX Autos",
];
export type PipelineState =
  | "ingested"
  | "classified"
  | "embedded"
  | "routed"
  | "synthesized"
  | "dropped";

export type SourceType = "rss" | "google_news";

export interface Source {
  id: string;
  name: string;
  url: string;
  source_type: SourceType;
  is_active: boolean;
  fetch_interval_minutes: number;
  last_fetched_at: string | null;
  last_status: string | null;
}

export interface Article {
  id: string;
  source_id: string | null;
  source_name: string;
  title: string;
  summary: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
  fetched_at: string;
  importance: Importance | null;
  reasoning: string | null;
  bucket: Bucket;
  entities: string[];
  primary_competitor: PrimaryCompetitor;
  cars24_implication: string | null;
  classified_at: string | null;
  embedding: number[] | null;
  embedded_at: string | null;
  cluster_id: string | null;
  routed_at: string | null;
  pipeline_state: PipelineState;
}

export interface Cluster {
  id: string;
  centroid: number[] | null;
  theme: string | null;
  primary_competitor: PrimaryCompetitor;
  earliest_article_at: string | null;
  latest_article_at: string | null;
  article_count: number;
  needs_synthesis: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Story {
  id: string;
  cluster_id: string;
  title: string;
  short_summary: string | null;
  summary: string;
  cars24_implication: string | null;
  importance: Exclude<Importance, "DROP">;
  bucket: Exclude<Bucket, null>;
  primary_competitor: PrimaryCompetitor;
  entities: string[];
  source_count: number;
  source_articles: Array<{
    name: string;
    url: string;
    published_at: string;
    title: string;
  }>;
  primary_source_name: string | null;
  primary_source_url: string | null;
  image_url: string | null;
  published_at: string;
  created_at: string;
  updated_at: string;
}

// LLM output schemas

export interface ClassificationResult {
  importance: Importance;
  bucket: Bucket;
  reasoning: string;
  entities: string[];
  primary_competitor: PrimaryCompetitor;
  cars24_implication: string | null;
}

export interface RoutingDecision {
  decision: "route_to_existing" | "create_new";
  cluster_id: string | null;
  reasoning: string;
}

export interface SynthesisResult {
  title: string;
  short_summary: string;
  summary: string;
  cars24_implication: string | null;
  importance: Exclude<Importance, "DROP">;
}
