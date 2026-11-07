import { LeadRecord, SalesAgent } from './types';

export interface DistributorState {
  currentIndex: number;
  stats: Record<string, number>;
}

export class RoundRobinDistributor {
  private agents: SalesAgent[] = [];
  private currentIndex: number = 0;
  private leadCountStats: Map<string, number> = new Map();

  constructor(initialAgents: SalesAgent[] = []) {
    this.setAgents(initialAgents);
  }

  /**
   * Set or update the pool of sales agents.
   */
  public setAgents(agents: SalesAgent[]): void {
    this.agents = [...agents];
    for (const agent of this.agents) {
      if (!this.leadCountStats.has(agent.id)) {
        this.leadCountStats.set(agent.id, 0);
      }
    }
  }

  /**
   * Add a single sales agent.
   */
  public addAgent(agent: SalesAgent): void {
    const existingIndex = this.agents.findIndex((a) => a.id === agent.id);
    if (existingIndex >= 0) {
      this.agents[existingIndex] = agent;
    } else {
      this.agents.push(agent);
      this.leadCountStats.set(agent.id, 0);
    }
  }

  /**
   * Remove an agent by ID.
   */
  public removeAgent(agentId: string): boolean {
    const initialLen = this.agents.length;
    this.agents = this.agents.filter((a) => a.id !== agentId);
    this.leadCountStats.delete(agentId);
    return this.agents.length < initialLen;
  }

  /**
   * Get all registered agents.
   */
  public getAgents(): SalesAgent[] {
    return [...this.agents];
  }

  /**
   * Get all active agents eligible for receiving leads.
   */
  public getActiveAgents(): SalesAgent[] {
    return this.agents.filter((a) => {
      if (!a.isActive) return false;
      if (a.maxDailyLeads && a.maxDailyLeads > 0) {
        const count = this.leadCountStats.get(a.id) || 0;
        if (count >= a.maxDailyLeads) return false;
      }
      return true;
    });
  }

  /**
   * Selects the next agent using weighted round-robin distribution.
   * If all active agents have weight=1, this simplifies to pure round-robin.
   */
  public nextAgent(): SalesAgent | null {
    const activeAgents = this.getActiveAgents();
    if (activeAgents.length === 0) {
      return null;
    }

    // Expand pool based on weights (e.g., weight 2 means 2 slots in round-robin sequence)
    const weightedPool: SalesAgent[] = [];
    for (const agent of activeAgents) {
      const weight = Math.max(1, agent.weight || 1);
      for (let i = 0; i < weight; i++) {
        weightedPool.push(agent);
      }
    }

    if (weightedPool.length === 0) {
      return null;
    }

    const selectedAgent = weightedPool[this.currentIndex % weightedPool.length];
    this.currentIndex = (this.currentIndex + 1) % weightedPool.length;

    // Track statistics
    const currentCount = this.leadCountStats.get(selectedAgent.id) || 0;
    this.leadCountStats.set(selectedAgent.id, currentCount + 1);

    return selectedAgent;
  }

  /**
   * Assigns an incoming lead to the next available agent.
   */
  public assignLead(lead: LeadRecord): LeadRecord {
    const agent = this.nextAgent();
    if (!agent) {
      return lead;
    }

    const nowIso = new Date().toISOString();
    return {
      ...lead,
      assignedTo: agent.id,
      assignedAgentName: agent.name,
      assignedAt: nowIso,
      status: 'ASSIGNED',
      updatedAt: nowIso,
    };
  }

  /**
   * Distributes a batch of leads across active agents.
   */
  public distributeBatch(leads: LeadRecord[]): {
    assigned: LeadRecord[];
    unassigned: LeadRecord[];
  } {
    const assigned: LeadRecord[] = [];
    const unassigned: LeadRecord[] = [];

    for (const lead of leads) {
      const agent = this.nextAgent();
      if (agent) {
        const nowIso = new Date().toISOString();
        assigned.push({
          ...lead,
          assignedTo: agent.id,
          assignedAgentName: agent.name,
          assignedAt: nowIso,
          status: 'ASSIGNED',
          updatedAt: nowIso,
        });
      } else {
        unassigned.push(lead);
      }
    }

    return { assigned, unassigned };
  }

  /**
   * Get assignment stats (lead count per agent ID).
   */
  public getStats(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, count] of this.leadCountStats.entries()) {
      result[id] = count;
    }
    return result;
  }

  /**
   * Exports distributor internal state for persistence (e.g. in Redis or DB).
   */
  public exportState(): DistributorState {
    return {
      currentIndex: this.currentIndex,
      stats: this.getStats(),
    };
  }

  /**
   * Restores distributor internal state.
   */
  public loadState(state: Partial<DistributorState>): void {
    if (typeof state.currentIndex === 'number') {
      this.currentIndex = state.currentIndex;
    }
    if (state.stats) {
      for (const [id, count] of Object.entries(state.stats)) {
        this.leadCountStats.set(id, count);
      }
    }
  }

  /**
   * Resets internal index and assignment count stats.
   */
  public reset(): void {
    this.currentIndex = 0;
    for (const agent of this.agents) {
      this.leadCountStats.set(agent.id, 0);
    }
  }
}

/**
 * Functional stateless helper: distributes an array of leads across agents using pure round-robin.
 */
export function distributeRoundRobin(
  leads: LeadRecord[],
  agents: SalesAgent[]
): LeadRecord[] {
  const distributor = new RoundRobinDistributor(agents);
  return leads.map((lead) => distributor.assignLead(lead));
}
