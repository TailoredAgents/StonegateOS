export type PipelineView = "board" | "list";

export type PipelineContact = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  source?: string | null;
  pipeline: {
    stage: string;
    notes: string | null;
    updatedAt: string | null;
  };
  property: {
    id: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
    outOfArea?: boolean | null;
  } | null;
  stats: {
    appointments: number;
    quotes: number;
  };
  notesCount: number;
  lastActivityAt: string | null;
  updatedAt: string;
  createdAt: string;
};

export type PipelineLane = {
  stage: string;
  contacts: PipelineContact[];
};

export type PipelineResponse = {
  stages: string[];
  lanes: PipelineLane[];
  stageCounts: Record<string, number>;
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  filters: {
    q: string;
    stage: string | null;
    excludeOutbound: boolean;
  };
};
