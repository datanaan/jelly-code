/**
 * Enhanced bus factor calculator — computes minimum authors whose departure
 * leaves >threshold% modules unmaintained.
 *
 * Reference: Avelino et al. "A novel approach for estimating Truck Factors" (2016)
 *
 * Bus factor = minimum number of primary authors whose removal causes
 * more than threshold% of modules to become orphaned (no remaining primary author).
 *
 * A "primary author" for a module is the author with the highest ownership (>0.5).
 * A module is "orphaned" when all its primary authors have been removed.
 */

import type { IGraphStore } from "../store/interfaces.js";
import type { BusFactorReport } from "./types.js";

/**
 * Module-author ownership record from graph query.
 */
interface ModuleAuthor {
  moduleId: string;
  moduleName: string;
  authorId: string;
  name: string;
  email: string;
  ownership: number;
}

/**
 * Calculate bus factor with configurable threshold.
 *
 * Algorithm:
 * 1. Get all module -> primary author mappings (ownership > 0.5)
 * 2. For each module, identify the single primary author (highest ownership)
 * 3. Sort authors by module count ascending
 * 4. Remove one author at a time, count orphaned modules
 * 5. When orphaned > threshold * totalModules, busFactor = number removed
 */
export async function calculateEnhancedBusFactor(
  projectId: string,
  graphStore: IGraphStore,
  threshold: number = 0.5,
): Promise<BusFactorReport> {
  const moduleAuthors = await queryModuleAuthors(projectId, graphStore);

  if (moduleAuthors.length === 0) {
    return {
      projectId,
      busFactor: -1,
      criticalAuthors: [],
      riskModules: [],
      threshold,
      message: "No temporal data available for bus factor calculation",
    };
  }

  // Build primary author per module: author with highest ownership > 0.5
  const primaryAuthorByModule = new Map<string, ModuleAuthor>();
  for (const ma of moduleAuthors) {
    const existing = primaryAuthorByModule.get(ma.moduleId);
    if (!existing || ma.ownership > existing.ownership) {
      primaryAuthorByModule.set(ma.moduleId, ma);
    }
  }

  const totalModules = primaryAuthorByModule.size;
  if (totalModules === 0) {
    return {
      projectId,
      busFactor: -1,
      criticalAuthors: [],
      riskModules: [],
      threshold,
      message: "No temporal data available for bus factor calculation",
    };
  }

  // Count modules per primary author
  const authorModuleCount = new Map<string, { name: string; email: string; ownedModules: number }>();
  for (const [, ma] of primaryAuthorByModule) {
    const entry = authorModuleCount.get(ma.authorId);
    if (entry) {
      entry.ownedModules++;
    } else {
      authorModuleCount.set(ma.authorId, {
        name: ma.name,
        email: ma.email,
        ownedModules: 1,
      });
    }
  }

  // Sort authors by module count ascending (remove least impactful first)
  const sortedAuthors = [...authorModuleCount.entries()]
    .sort((a, b) => a[1].ownedModules - b[1].ownedModules)
    .map(([authorId, info]) => ({
      authorId,
      name: info.name,
      email: info.email,
      ownedModules: info.ownedModules,
    }));

  // Bus factor algorithm: remove authors one by one
  const orphanThreshold = Math.floor(totalModules * threshold);
  const removedAuthors = new Set<string>();
  let busFactor = 0;

  for (const author of sortedAuthors) {
    removedAuthors.add(author.authorId);
    busFactor++;

    // Count orphaned modules: modules whose primary author has been removed
    let orphanedCount = 0;
    for (const [, ma] of primaryAuthorByModule) {
      if (removedAuthors.has(ma.authorId)) {
        orphanedCount++;
      }
    }

    if (orphanedCount > orphanThreshold) {
      break;
    }
  }

  // Find risk modules: modules with only ONE author having ownership > 0.5
  const riskModules = findRiskModulesInternal(moduleAuthors, primaryAuthorByModule);

  // Critical authors: sorted by ownedModules descending
  const criticalAuthors = [...sortedAuthors].sort((a, b) => b.ownedModules - a.ownedModules);

  return {
    projectId,
    busFactor,
    criticalAuthors,
    riskModules,
    threshold,
  };
}

/**
 * Find critical authors — those who own the most modules.
 */
export async function findCriticalAuthors(
  projectId: string,
  graphStore: IGraphStore,
  threshold: number = 0.5,
): Promise<BusFactorReport["criticalAuthors"]> {
  const report = await calculateEnhancedBusFactor(projectId, graphStore, threshold);
  return report.criticalAuthors;
}

/**
 * Find risk modules — modules with only one primary author.
 */
export async function findRiskModules(
  projectId: string,
  graphStore: IGraphStore,
): Promise<BusFactorReport["riskModules"]> {
  const moduleAuthors = await queryModuleAuthors(projectId, graphStore);

  if (moduleAuthors.length === 0) {
    return [];
  }

  // Build primary author per module
  const primaryAuthorByModule = new Map<string, ModuleAuthor>();
  for (const ma of moduleAuthors) {
    const existing = primaryAuthorByModule.get(ma.moduleId);
    if (!existing || ma.ownership > existing.ownership) {
      primaryAuthorByModule.set(ma.moduleId, ma);
    }
  }

  return findRiskModulesInternal(moduleAuthors, primaryAuthorByModule);
}

/**
 * Query module-author ownership data from the graph store.
 * Uses Community nodes (from Leiden decomposition) linked via MEMBER_OF relations.
 */
async function queryModuleAuthors(
  projectId: string,
  graphStore: IGraphStore,
): Promise<ModuleAuthor[]> {
  const results = await graphStore.query(
    `MATCH (c:Community {projectId: $projectId})<-[r:CODE_RELATION {type: 'MEMBER_OF'}]-(n)
     WHERE n.projectId = $projectId
     MATCH (n)-[ab:CODE_RELATION {type: 'AUTHORED_BY', projectId: $projectId}]->(a:Author)
     WHERE ab.ownership > 0.5
     RETURN c.id AS moduleId, c.label AS moduleName, a.id AS authorId, a.name AS name, a.email AS email, ab.ownership AS ownership`,
    { projectId },
  );

  return results.map((row) => ({
    moduleId: row.moduleId as string,
    moduleName: (row.moduleName as string) ?? "",
    authorId: row.authorId as string,
    name: (row.name as string) ?? "",
    email: (row.email as string) ?? "",
    ownership:
      typeof row.ownership === "number"
        ? row.ownership
        : Number(row.ownership),
  }));
}

/**
 * Internal helper to find risk modules from pre-fetched data.
 * A risk module is one where only ONE author has ownership > 0.5.
 */
function findRiskModulesInternal(
  moduleAuthors: ModuleAuthor[],
  primaryAuthorByModule: Map<string, ModuleAuthor>,
): BusFactorReport["riskModules"] {
  // Count authors per module with ownership > 0.5
  const authorsPerModule = new Map<string, number>();
  for (const ma of moduleAuthors) {
    const count = authorsPerModule.get(ma.moduleId) ?? 0;
    authorsPerModule.set(ma.moduleId, count + 1);
  }

  const riskModules: BusFactorReport["riskModules"] = [];
  for (const [moduleId, authorCount] of authorsPerModule) {
    if (authorCount === 1) {
      const primary = primaryAuthorByModule.get(moduleId);
      if (primary) {
        riskModules.push({
          moduleId,
          moduleName: primary.moduleName,
          soleAuthorId: primary.authorId,
        });
      }
    }
  }

  return riskModules;
}
