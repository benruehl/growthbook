import { useEffect, useMemo } from "react";
import {
  Environment,
  NamespaceUsage,
  OrganizationSettings,
  SDKAttributeFormat,
  SDKAttributeSchema,
  SDKAttributeType,
} from "back-end/types/organization";
import {
  ExperimentRefRule,
  ExperimentRule,
  ExperimentValue,
  FeatureInterface,
  FeatureRule,
  FeatureValueType,
  ForceRule,
  RolloutRule,
  ComputedFeatureInterface,
} from "back-end/types/feature";
import stringify from "json-stringify-pretty-compact";
import { ExperimentInterfaceStringDates } from "back-end/types/experiment";
import { FeatureUsageRecords } from "back-end/types/realtime";
import cloneDeep from "lodash/cloneDeep";
import {
  featureHasEnvironment,
  featuresReferencingSavedGroups,
  generateVariationId,
  getMatchingRules,
  StaleFeatureReason,
  validateAndFixCondition,
  validateFeatureValue,
} from "shared/util";
import { FeatureRevisionInterface } from "back-end/types/feature-revision";
import isEqual from "lodash/isEqual";
import { ExperimentLaunchChecklistInterface } from "back-end/types/experimentLaunchChecklist";
import { SavedGroupInterface } from "shared/src/types";
import { SafeRolloutRule } from "back-end/src/validators/features";
import { DataSourceInterfaceWithParams } from "back-end/types/datasource";
import { getUpcomingScheduleRule } from "@/services/scheduleRules";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { validateSavedGroupTargeting } from "@/components/Features/SavedGroupTargetingField";
import useOrgSettings from "@/hooks/useOrgSettings";
import useApi from "@/hooks/useApi";
import { useAddComputedFields, useSearch } from "@/services/search";
import { useUser } from "@/services/UserContext";
import { ALL_COUNTRY_CODES } from "@/components/Forms/CountrySelector";
import useSDKConnections from "@/hooks/useSDKConnections";
import {
  CheckListItem,
  getChecklistItems,
} from "@/components/Experiment/PreLaunchChecklist";
import { SafeRolloutRuleCreateFields } from "@/components/Features/RuleModal";
import { useDefinitions } from "./DefinitionsContext";

export { generateVariationId } from "shared/util";

export interface Condition {
  field: string;
  operator: string;
  value: string;
}

export interface AttributeData {
  attribute: string;
  datatype: "boolean" | "number" | "string" | "secureString";
  array: boolean;
  identifier: boolean;
  enum: string[];
  archived: boolean;
  format?: SDKAttributeFormat;
  disableEqualityConditions?: boolean;
}

export type NewExperimentRefRule = {
  type: "experiment-ref-new";
  name: string;
} & Omit<ExperimentRule, "type">;

export function useEnvironmentState() {
  const [state, setState] = useLocalStorage("currentEnvironment", "dev");

  const environments = useEnvironments();

  if (!environments.map((e) => e.id).includes(state)) {
    return [environments[0]?.id || "production", setState] as const;
  }

  return [state, setState] as const;
}

export function useEnvironments() {
  const { environments } = useOrgSettings();

  if (!environments || !environments.length) {
    return [
      {
        id: "dev",
        description: "",
        toggleOnList: true,
        projects: [],
      },
      {
        id: "production",
        description: "",
        toggleOnList: true,
        projects: [],
      },
    ];
  }

  return environments;
}

export function useFeatureSearch({
  allFeatures,
  defaultSortField = "id",
  filterResults,
  environments,
  localStorageKey = "features",
  staleFeatures,
}: {
  allFeatures: FeatureInterface[];
  defaultSortField?:
    | "id"
    | "description"
    | "tags"
    | "defaultValue"
    | "dateCreated"
    | "dateUpdated";
  filterResults?: (items: FeatureInterface[]) => FeatureInterface[];
  environments: Environment[];
  localStorageKey?: string;
  staleFeatures?: Record<
    string,
    { stale: boolean; reason?: StaleFeatureReason }
  >;
}) {
  const { getUserDisplay } = useUser();
  const { getProjectById, getSavedGroupById, savedGroups } = useDefinitions();
  const savedGroupReferencesByFeature = useMemo(() => {
    const savedGroupReferencesByGroup = featuresReferencingSavedGroups({
      savedGroups,
      features: allFeatures,
      environments,
    });
    // Invert the map from groupId->featureList to featureId->groupList
    const savedGroupReferencesByFeature: Record<
      string,
      SavedGroupInterface[]
    > = {};
    Object.keys(savedGroupReferencesByGroup).forEach((groupId) => {
      const savedGroup = getSavedGroupById(groupId);
      if (!savedGroup) return;
      savedGroupReferencesByGroup[groupId].forEach((referencingFeature) => {
        savedGroupReferencesByFeature[referencingFeature.id] ||= [];
        savedGroupReferencesByFeature[referencingFeature.id].push(savedGroup);
      });
    });
    return savedGroupReferencesByFeature;
  }, [savedGroups, allFeatures, environments]);

  const features = useAddComputedFields(
    allFeatures,
    (f) => {
      const projectId = f.project;
      const projectName = projectId ? getProjectById(projectId)?.name : "";
      const projectIsDeReferenced = projectId && !projectName;
      return {
        ...f,
        projectId,
        projectName,
        projectIsDeReferenced,
        savedGroups: (savedGroupReferencesByFeature[f.id] || []).map(
          (grp) => grp.groupName
        ),
        ownerName: getUserDisplay(f.owner, false) || "",
      };
    },
    [getProjectById, savedGroupReferencesByFeature]
  );
  return useSearch({
    items: features,
    defaultSortField: defaultSortField,
    searchFields: ["id^3", "description", "tags^2", "defaultValue"],
    filterResults,
    updateSearchQueryOnChange: true,
    localStorageKey: localStorageKey,
    searchTermFilters: {
      is: (item) => {
        const is: string[] = [item.valueType];
        if (item.archived) is.push("archived");
        if (item.hasDrafts) is.push("draft");
        if (item.valueType === "json") is.push("json");
        if (item.valueType === "string") is.push("string");
        if (item.valueType === "number") is.push("number");
        if (item.valueType === "boolean") is.push("boolean");
        if (staleFeatures?.[item.id]?.stale) is.push("stale");
        return is;
      },
      has: (item) => {
        const has: string[] = [];
        if (item.project) has.push("project");
        if (item.hasDrafts) has.push("draft", "drafts");
        if (item.prerequisites?.length) has.push("prerequisites", "prereqs");

        if (item.valueType === "json" && item.jsonSchema?.enabled) {
          has.push("validation", "schema", "jsonSchema");
        }

        const rules = getMatchingRules(
          item,
          () => true,
          environments.map((e) => e.id)
        );

        if (rules.length) has.push("rule", "rules");
        if (
          rules.some((r) =>
            ["experiment", "experiment-ref"].includes(r.rule.type)
          )
        ) {
          has.push("experiment", "experiments");
        }
        if (rules.some((r) => r.rule.type === "rollout")) {
          has.push("rollout", "percent");
        }
        if (rules.some((r) => r.rule.type === "force")) {
          has.push("force", "targeting");
        }

        return has;
      },
      key: (item) => item.id,
      project: (item: ComputedFeatureInterface) => [
        item.project,
        item.projectName,
      ],
      created: (item) => new Date(item.dateCreated),
      updated: (item) => new Date(item.dateUpdated),
      experiment: (item) => item.linkedExperiments || [],
      savedgroup: (item: ComputedFeatureInterface) => item.savedGroups || [],
      version: (item) => item.version,
      revision: (item) => item.version,
      owner: (item) => item.owner,
      tag: (item) => item.tags,
      type: (item) => item.valueType,
      rules: (item) => {
        const rules = getMatchingRules(
          item,
          () => true,
          environments.map((e) => e.id)
        );
        return rules.length;
      },
      on: (item) => {
        const on: string[] = [];
        environments.forEach((e) => {
          if (
            featureHasEnvironment(item, e) &&
            item.environmentSettings?.[e.id]?.enabled
          ) {
            on.push(e.id);
          }
        });
        return on;
      },
      off: (item) => {
        const off: string[] = [];
        environments.forEach((e) => {
          if (
            featureHasEnvironment(item, e) &&
            !item.environmentSettings?.[e.id]?.enabled
          ) {
            off.push(e.id);
          }
        });
        return off;
      },
    },
  });
}

export function getRules(feature: FeatureInterface, environment: string) {
  return feature?.environmentSettings?.[environment]?.rules ?? [];
}
export function getFeatureDefaultValue(feature: FeatureInterface) {
  return feature.defaultValue ?? "";
}
export function getPrerequisites(feature: FeatureInterface) {
  return feature.prerequisites ?? [];
}

export function roundVariationWeight(num: number): number {
  return Math.round(num * 1000) / 1000;
}
export function getTotalVariationWeight(weights: number[]): number {
  return roundVariationWeight(weights.reduce((sum, w) => sum + w, 0));
}

export function getVariationDefaultName(
  val: ExperimentValue,
  type: FeatureValueType
) {
  if (val.name) {
    return val.name;
  }

  if (type === "boolean") {
    return val.value === "true" ? "On" : "Off";
  }

  if (type === "json") {
    return "";
  }

  return val.value;
}

export function isRuleInactive(
  rule: FeatureRule,
  experimentsMap: Map<string, ExperimentInterfaceStringDates>
): boolean {
  // Explicitly disabled
  if (!rule.enabled) return true;

  // Was scheduled to be disabled and that time has passed
  const upcomingScheduleRule = getUpcomingScheduleRule(rule);
  const scheduleCompletedAndDisabled =
    !upcomingScheduleRule &&
    rule?.scheduleRules?.length &&
    rule.scheduleRules.at(-1)?.timestamp !== null;
  if (scheduleCompletedAndDisabled) {
    return true;
  }
  if (rule.type === "safe-rollout") {
    if (rule.status === "stopped") {
      return true;
    }
  }
  // Linked experiment is missing, archived, or stopped with no temp rollout
  if (rule.type === "experiment-ref") {
    const linkedExperiment = experimentsMap.get(rule.experimentId);
    if (!linkedExperiment) {
      return true;
    }
    if (linkedExperiment.archived) {
      return true;
    }
    if (
      linkedExperiment.status === "stopped" &&
      (linkedExperiment.excludeFromPayload ||
        !linkedExperiment.releasedVariationId)
    ) {
      return true;
    }
  }

  // Otherwise, it is active
  return false;
}

type NamespaceGaps = { start: number; end: number }[];
export function findGaps(
  namespaces: NamespaceUsage,
  namespace: string,
  featureId: string = "",
  trackingKey: string = ""
): NamespaceGaps {
  const experiments = namespaces?.[namespace] || [];

  // Sort by range start, ascending
  const ranges = [
    ...experiments.filter(
      // Exclude the current feature/experiment
      (e) => e.id !== featureId || e.trackingKey !== trackingKey
    ),
    { start: 1, end: 1 },
  ];
  ranges.sort((a, b) => a.start - b.start);

  // Look for gaps between ranges
  const gaps: NamespaceGaps = [];
  let lastEnd = 0;
  ranges.forEach(({ start, end }) => {
    if (start > lastEnd) {
      gaps.push({
        start: lastEnd,
        end: start,
      });
    }
    lastEnd = Math.max(lastEnd, end);
  });

  return gaps;
}

export function useFeaturesList(withProject = true, includeArchived = false) {
  const { project } = useDefinitions();

  const qs = new URLSearchParams();
  if (withProject) {
    qs.set("project", project);
  }
  if (includeArchived) {
    qs.set("includeArchived", "true");
  }

  const url = `/feature?${qs.toString()}`;

  const { data, error, mutate } = useApi<{
    features: FeatureInterface[];
    linkedExperiments: ExperimentInterfaceStringDates[];
    hasArchived: boolean;
  }>(url);

  const { features, experiments, hasArchived } = useMemo(() => {
    if (data) {
      return {
        features: data.features,
        experiments: data.linkedExperiments,
        hasArchived: data.hasArchived,
      };
    }
    return {
      features: [],
      experiments: [],
      hasArchived: false,
    };
  }, [data]);

  return {
    features,
    experiments,
    loading: !data,
    error,
    mutate,
    hasArchived,
  };
}

export function getVariationColor(i: number, experimentTheme = false) {
  const colors = !experimentTheme
    ? [
        "#8f66dc",
        "#e5a6f3",
        "#38aecc",
        "#f5dd90",
        "#3383ec",
        "#80c17b",
        "#79c4e0",
        "#f87a7a",
        "#6cc160",
      ]
    : [
        /* This should match the variant colors defined in _colors.scss */
        "var(--blue-8)",
        "var(--teal-10)",
        "var(--orange-10)",
        "var(--pink-10)",
        "var(--amber-10)",
        "var(--mint-10)",
        "var(--lime-11)",
        "var(--cyan-10)",
        "var(--red-10)",
      ];
  return colors[i % colors.length];
}

export function useAttributeSchema(
  showArchived = false,
  projectFilter?: string
) {
  const attributeSchema = useOrgSettings().attributeSchema || [];

  const filteredAttributeSchema = attributeSchema.filter((attribute) => {
    return (
      !projectFilter ||
      !attribute.projects?.length ||
      attribute.projects.includes(projectFilter)
    );
  });
  return useMemo(() => {
    if (!showArchived) {
      return filteredAttributeSchema.filter((s) => !s.archived);
    }
    return filteredAttributeSchema;
  }, [attributeSchema, showArchived, projectFilter]);
}

export function validateFeatureRule(
  rule: FeatureRule,
  feature: Pick<FeatureInterface, "valueType" | "jsonSchema">
): null | FeatureRule {
  let hasChanges = false;
  const ruleCopy = cloneDeep(rule);

  validateSavedGroupTargeting(rule.savedGroups);

  if (rule.condition) {
    validateAndFixCondition(
      rule.condition,
      (condition) => {
        hasChanges = true;
        ruleCopy.condition = condition;
      },
      false
    );
  }
  if (rule.prerequisites) {
    if (rule.prerequisites.some((p) => !p.id)) {
      throw new Error("Cannot have empty prerequisites");
    }
  }
  if (rule.type === "force") {
    const newValue = validateFeatureValue(
      feature,
      rule.value,
      "Value to Force"
    );
    if (newValue !== rule.value) {
      hasChanges = true;
      (ruleCopy as ForceRule).value = newValue;
    }
  } else if (rule.type === "experiment") {
    const ruleValues = rule.values;
    if (!ruleValues || !ruleValues.length) {
      throw new Error("Must set at least one value");
    }
    let totalWeight = 0;
    ruleValues.forEach((val, i) => {
      if (val.weight < 0)
        throw new Error("Variation weights cannot be negative");
      totalWeight += val.weight;
      const newValue = validateFeatureValue(
        feature,
        val.value,
        "Variation #" + i
      );
      if (newValue !== val.value) {
        hasChanges = true;
        (ruleCopy as ExperimentRule).values[i].value = newValue;
      }
    });
    // Without this rounding here, JS floating point messes up simple addition.
    totalWeight = roundVariationWeight(totalWeight);

    if (totalWeight > 1) {
      throw new Error(
        `Sum of weights cannot be greater than 1 (currently equals ${totalWeight})`
      );
    }
  } else if (rule.type === "experiment-ref") {
    rule.variations.forEach((v, i) => {
      const newValue = validateFeatureValue(
        feature,
        v.value,
        "Variation #" + i
      );
      if (newValue !== v.value) {
        hasChanges = true;
        (ruleCopy as ExperimentRefRule).variations[i].value = newValue;
      }
    });
  } else if (rule.type === "safe-rollout") {
    const newVariationValue = validateFeatureValue(
      feature,
      rule.variationValue,
      "Value to Rollout"
    );
    if (newVariationValue !== rule.variationValue) {
      hasChanges = true;
      (ruleCopy as SafeRolloutRule).variationValue = newVariationValue;
    }
    const newControlValue = validateFeatureValue(
      feature,
      rule.controlValue,
      "Control Value"
    );
    if (newControlValue !== rule.controlValue) {
      hasChanges = true;
      (ruleCopy as SafeRolloutRule).controlValue = newControlValue;
    }
  } else {
    const newValue = validateFeatureValue(
      feature,
      rule.value,
      "Value to Rollout"
    );
    if (newValue !== rule.value) {
      hasChanges = true;
      (ruleCopy as RolloutRule).value = newValue;
    }

    if (rule.type === "rollout" && (rule.coverage < 0 || rule.coverage > 1)) {
      throw new Error("Rollout percent must be between 0 and 1");
    }
  }

  return hasChanges ? ruleCopy : null;
}

export function getEnabledEnvironments(
  feature: FeatureInterface,
  environments: Environment[]
) {
  return Object.keys(feature.environmentSettings ?? {}).filter((env) => {
    if (!environments.some((e) => e.id === env)) return false;
    return !!feature.environmentSettings?.[env]?.enabled;
  });
}

export function getAffectedEnvs(
  feature: FeatureInterface,
  changedEnvs: string[]
): string[] {
  const settings = feature.environmentSettings;
  if (!settings) return [];

  return changedEnvs.filter((e) => settings?.[e]?.enabled);
}

export function getDefaultValue(valueType: FeatureValueType): string {
  if (valueType === "boolean") {
    return "false";
  }
  if (valueType === "number") {
    return "1";
  }
  if (valueType === "string") {
    return "OFF"; // Default Values should be the OFF State to match most platforms.
  }
  if (valueType === "json") {
    return "{}";
  }
  return "";
}

export function getAffectedRevisionEnvs(
  liveFeature: FeatureInterface,
  revision: FeatureRevisionInterface,
  environments: Environment[]
): string[] {
  const enabledEnvs = getEnabledEnvironments(liveFeature, environments);
  if (revision.defaultValue !== liveFeature.defaultValue) return enabledEnvs;

  return enabledEnvs.filter((env) => {
    const liveRules = liveFeature.environmentSettings?.[env]?.rules || [];
    const revisionRules = revision.rules?.[env] || [];

    return !isEqual(liveRules, revisionRules);
  });
}

export function getDefaultVariationValue(defaultValue: string) {
  const map: Record<string, string> = {
    true: "false",
    false: "true",
    "1": "0",
    "0": "1",
    foo: "bar",
    bar: "foo",
  };
  return defaultValue in map ? map[defaultValue] : defaultValue;
}
type safeRolloutFields = Omit<
  SafeRolloutRuleCreateFields,
  "safeRolloutFields"
> & {
  safeRolloutFields: Omit<
    SafeRolloutRuleCreateFields["safeRolloutFields"],
    "maxDuration"
  >;
};
export function getDefaultRuleValue({
  defaultValue,
  attributeSchema,
  ruleType,
  settings,
  datasources,
  isSafeRolloutAutoRollbackEnabled = false,
}: {
  defaultValue: string;
  attributeSchema?: SDKAttributeSchema;
  ruleType: string;
  settings?: OrganizationSettings;
  datasources?: DataSourceInterfaceWithParams[];
  isSafeRolloutAutoRollbackEnabled?: boolean;
}): FeatureRule | NewExperimentRefRule | safeRolloutFields {
  const hashAttributes =
    attributeSchema?.filter((a) => a.hashAttribute)?.map((a) => a.property) ||
    [];

  const hashAttribute = hashAttributes.includes("id")
    ? "id"
    : hashAttributes[0] || "id";
  let defaultDataSource = settings?.defaultDataSource;
  if (datasources && !defaultDataSource && datasources.length === 1) {
    defaultDataSource = datasources[0].id;
  }
  const value = getDefaultVariationValue(defaultValue);
  if (ruleType === "rollout") {
    return {
      type: "rollout",
      description: "",
      id: "",
      value,
      coverage: 1, // we are hardcoding the coverage to 1 for now
      condition: "",
      enabled: true,
      hashAttribute,
      scheduleRules: [
        {
          enabled: true,
          timestamp: null,
        },
        {
          enabled: false,
          timestamp: null,
        },
      ],
    };
  }
  if (ruleType === "safe-rollout") {
    return {
      type: "safe-rollout",
      description: "",
      id: "",
      condition: "",
      safeRolloutId: "",
      enabled: true,
      prerequisites: [],
      controlValue: defaultValue,
      variationValue: value,
      hashAttribute: "id",
      trackingKey: "",
      seed: "",
      status: "running",
      safeRolloutFields: {
        datasourceId: defaultDataSource || "",
        exposureQueryId: "",
        guardrailMetricIds: [],
        autoRollback: isSafeRolloutAutoRollbackEnabled,
      },
    };
  }
  if (ruleType === "experiment") {
    return {
      type: "experiment",
      description: "",
      id: "",
      condition: "",
      enabled: true,
      hashAttribute,
      trackingKey: "",
      values: [
        {
          value: defaultValue,
          weight: 0.5,
          name: "",
        },
        {
          value: value,
          weight: 0.5,
          name: "",
        },
      ],
      coverage: 1,
      namespace: {
        enabled: false,
        name: "",
        range: [0, 0.5],
      },
      scheduleRules: [
        {
          enabled: true,
          timestamp: null,
        },
        {
          enabled: false,
          timestamp: null,
        },
      ],
    };
  }
  if (ruleType === "experiment-ref") {
    return {
      type: "experiment-ref",
      description: "",
      experimentId: "",
      id: "",
      variations: [],
      condition: "",
      enabled: true,
      scheduleRules: [
        {
          enabled: true,
          timestamp: null,
        },
        {
          enabled: false,
          timestamp: null,
        },
      ],
    };
  }
  if (ruleType === "experiment-ref-new") {
    return {
      type: "experiment-ref-new",
      experimentType: "standard",
      description: "",
      name: "",
      id: "",
      condition: "",
      enabled: true,
      hashAttribute,
      trackingKey: "",
      values: [
        {
          value: defaultValue,
          weight: 0.5,
          name: "Control",
        },
        {
          value: value,
          weight: 0.5,
          name: "Variation 1",
        },
      ],
      coverage: 1,
      namespace: {
        enabled: false,
        name: "",
        range: [0, 0.5],
      },
      scheduleRules: [
        {
          enabled: true,
          timestamp: null,
        },
        {
          enabled: false,
          timestamp: null,
        },
      ],
    };
  }
  if (ruleType === "force" || !ruleType) {
    return {
      type: "force",
      description: "",
      id: "",
      value,
      enabled: true,
      condition: "",
      savedGroups: [],
      scheduleRules: [
        {
          enabled: true,
          timestamp: null,
        },
        {
          enabled: false,
          timestamp: null,
        },
      ],
    };
  }
  throw new Error("Unknown Rule Type: " + ruleType);
}

export function getUnreachableRuleIndex(
  rules: FeatureRule[],
  experimentsMap: Map<string, ExperimentInterfaceStringDates>
) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];

    // Skip over inactive rules
    if (isRuleInactive(rule, experimentsMap)) continue;

    // Skip rules that are conditional based on a schedule
    const upcomingScheduleRule = getUpcomingScheduleRule(rule);
    if (upcomingScheduleRule && upcomingScheduleRule.timestamp) {
      continue;
    }

    // Skip rules with targeting conditions
    if (rule.condition && rule.condition !== "{}") {
      continue;
    }
    if (rule.savedGroups?.length) {
      continue;
    }
    if (rule.prerequisites?.length) {
      continue;
    }

    // Skip non-force rules (require a non-null hash attribute, so may not match)
    if (rule.type !== "force") {
      continue;
    }

    // By this point, we have a force rule that matches all users
    // Any rule after this is unreachable
    return i + 1;
  }

  // No unreachable rules
  return 0;
}

export function jsonToConds(
  json: string,
  attributes?: Map<string, AttributeData>
): null | Condition[] {
  if (!json || json === "{}") return [];
  // Advanced use case where we can't use the simple editor
  if (json.match(/\$(or|nor|all|type)/)) return null;

  try {
    const parsed = JSON.parse(json);
    if (parsed["$not"]) return null;

    const conds: Condition[] = [];
    let valid = true;

    Object.keys(parsed).forEach((field) => {
      if (attributes && !attributes.has(field)) {
        valid = false;
        return;
      }

      const value = parsed[field];
      if (Array.isArray(value)) {
        valid = false;
        return;
      }

      if (typeof value !== "object") {
        if (value === true || value === false) {
          return conds.push({
            field,
            operator: value ? "$true" : "$false",
            value: "",
          });
        }

        return conds.push({
          field,
          operator: "$eq",
          value: value + "",
        });
      }
      Object.keys(value).forEach((operator) => {
        const v = value[operator];

        if (operator === "$in" || operator === "$nin") {
          if (v.some((str) => typeof str === "string" && str.includes(","))) {
            valid = false;
            return;
          }
          return conds.push({
            field,
            operator,
            value: v.join(", "),
          });
        }

        if (operator === "$elemMatch") {
          if (typeof v === "object" && Object.keys(v).length === 1) {
            if ("$eq" in v && typeof v["$eq"] !== "object") {
              return conds.push({
                field,
                operator: "$includes",
                value: v["$eq"] + "",
              });
            }
          }
          valid = false;
          return;
        }

        if (operator === "$not") {
          if (typeof v === "object" && Object.keys(v).length === 1) {
            if ("$regex" in v && typeof v["$regex"] === "string") {
              return conds.push({
                field,
                operator: "$notRegex",
                value: v["$regex"],
              });
            }
            if ("$elemMatch" in v) {
              const m = v["$elemMatch"];
              if (typeof m === "object" && Object.keys(m).length === 1) {
                if ("$eq" in m && typeof m["$eq"] !== "object") {
                  return conds.push({
                    field,
                    operator: "$notIncludes",
                    value: m["$eq"] + "",
                  });
                }
              }
            }
          }
        }

        if (operator === "$size") {
          if (v === 0) {
            return conds.push({
              field,
              operator: "$empty",
              value: "",
            });
          }
          if (typeof v === "object" && Object.keys(v).length === 1) {
            if ("$gt" in v && v["$gt"] === 0) {
              return conds.push({
                field,
                operator: "$notEmpty",
                value: "",
              });
            }
          }
        }

        if (Array.isArray(v) || (v && typeof v === "object")) {
          valid = false;
          return;
        }

        if (operator === "$exists") {
          return conds.push({
            field,
            operator: v ? "$exists" : "$notExists",
            value: "",
          });
        }
        if (operator === "$eq" && (v === true || v === false)) {
          return conds.push({
            field,
            operator: v ? "$true" : "$false",
            value: "",
          });
        }
        if (operator === "$ne" && (v === true || v === false)) {
          return conds.push({
            field,
            operator: v ? "$false" : "$true",
            value: "",
          });
        }

        if (
          [
            "$eq",
            "$ne",
            "$gt",
            "$gte",
            "$lt",
            "$lte",
            "$regex",
            "$veq",
            "$vne",
            "$vgt",
            "$vgte",
            "$vlt",
            "$vlte",
          ].includes(operator) &&
          typeof v !== "object"
        ) {
          return conds.push({
            field,
            operator,
            value: v + "",
          });
        }

        if (
          (operator === "$inGroup" || operator === "$notInGroup") &&
          typeof v === "string"
        ) {
          return conds.push({
            field,
            operator,
            value: v,
          });
        }
        valid = false;
      });
    });
    if (!valid) return null;
    return conds;
  } catch (e) {
    return null;
  }
}

function parseValue(
  value: string,
  type?: "string" | "number" | "boolean" | "secureString"
) {
  if (type === "number") return parseFloat(value) || 0;
  if (type === "boolean") return value === "false" ? false : true;
  return value;
}

export function condToJson(
  conds: Condition[],
  attributes: Map<string, AttributeData>
) {
  const obj = {};
  conds.forEach(({ field, operator, value }) => {
    obj[field] = obj[field] || {};
    if (operator === "$notRegex") {
      obj[field]["$not"] = { $regex: value };
    } else if (operator === "$notExists") {
      obj[field]["$exists"] = false;
    } else if (operator === "$exists") {
      obj[field]["$exists"] = true;
    } else if (operator === "$true") {
      obj[field]["$eq"] = true;
    } else if (operator === "$false") {
      obj[field]["$eq"] = false;
    } else if (operator === "$includes") {
      obj[field]["$elemMatch"] = {
        $eq: parseValue(value, attributes.get(field)?.datatype),
      };
    } else if (operator === "$notIncludes") {
      obj[field]["$not"] = {
        $elemMatch: { $eq: parseValue(value, attributes.get(field)?.datatype) },
      };
    } else if (operator === "$empty") {
      obj[field]["$size"] = 0;
    } else if (operator === "$notEmpty") {
      obj[field]["$size"] = { $gt: 0 };
    } else if (operator === "$in" || operator === "$nin") {
      // Allow for the empty list
      if (value === "") {
        obj[field][operator] = [];
      } else {
        obj[field][operator] = value
          .split(",")
          .map((x) => x.trim())
          .map((x) => parseValue(x, attributes.get(field)?.datatype));
      }
    } else if (operator === "$inGroup" || operator === "$notInGroup") {
      obj[field][operator] = value;
    } else {
      obj[field][operator] = parseValue(value, attributes.get(field)?.datatype);
    }
  });

  // Simplify {$eg: ""} rules
  Object.keys(obj).forEach((key) => {
    if (Object.keys(obj[key]).length === 1 && "$eq" in obj[key]) {
      obj[key] = obj[key]["$eq"];
    }
  });

  return stringify(obj);
}

function getAttributeDataType(type: SDKAttributeType) {
  if (type === "boolean" || type === "number" || type === "string") return type;

  if (type === "enum" || type === "string[]") return "string";

  if (type === "secureString" || type === "secureString[]")
    return "secureString";

  return "number";
}

export function useAttributeMap(
  projectFilter?: string
): Map<string, AttributeData> {
  const attributeSchema = useAttributeSchema(true, projectFilter);

  return useMemo(() => {
    if (!attributeSchema.length) {
      return new Map();
    }

    const map = new Map<string, AttributeData>();
    attributeSchema.forEach((schema) => {
      map.set(schema.property, {
        attribute: schema.property,
        datatype: getAttributeDataType(schema.datatype),
        array: !!schema.datatype.match(/\[\]$/),
        enum:
          schema.datatype === "enum" && schema.enum
            ? schema.enum.split(",").map((x) => x.trim())
            : schema.format === "isoCountryCode"
            ? ALL_COUNTRY_CODES
            : [],
        identifier: !!schema.hashAttribute,
        archived: !!schema.archived,
        format: schema.format || "",
        disableEqualityConditions: !!schema.disableEqualityConditions,
      });
    });

    return map;
  }, [attributeSchema]);
}

export function getExperimentDefinitionFromFeature(
  feature: FeatureInterface,
  expRule: ExperimentRule
) {
  const trackingKey = expRule?.trackingKey || feature.id;
  if (!trackingKey) {
    return null;
  }

  const expDefinition: Partial<ExperimentInterfaceStringDates> = {
    trackingKey: trackingKey,
    name: trackingKey + " experiment",
    hypothesis: expRule.description || "",
    description: `Experiment analysis for the feature [**${feature.id}**](/features/${feature.id})`,
    variations: expRule.values.map((v, i) => {
      let name = i ? `Variation ${i}` : "Control";
      if (v?.name) {
        name = v.name;
      } else if (feature.valueType === "boolean") {
        name = v.value === "true" ? "On" : "Off";
      }
      return {
        name,
        key: i + "",
        id: generateVariationId(),
        screenshots: [],
        description: v.value,
      };
    }),
    phases: [
      {
        coverage: expRule.coverage || 1,
        variationWeights: expRule.values.map((v) => v.weight),
        name: "Main",
        reason: "",
        dateStarted: new Date().toISOString(),
        condition: expRule.condition || "",
        namespace: expRule.namespace || {
          enabled: false,
          name: "",
          range: [0, 0],
        },
        seed: trackingKey,
      },
    ],
  };
  return expDefinition;
}

export function useRealtimeData(
  features: FeatureInterface[] = [],
  mock = false,
  update = false
): { usage: FeatureUsageRecords; usageDomain: [number, number] } {
  const { data, mutate } = useApi<{ usage: FeatureUsageRecords }>(
    `/usage/features`,
    { shouldRun: () => !!update }
  );

  // Mock data
  const usage = useMemo(() => {
    if (!mock || !features) {
      return data?.usage || {};
    }
    const usage: FeatureUsageRecords = {};
    features.forEach((f) => {
      usage[f.id] = { realtime: [] };
      const usedRatio = Math.random();
      const volumeRatio = Math.random();
      for (let i = 0; i < 30; i++) {
        usage[f.id].realtime.push({
          used: Math.floor(Math.random() * 1000 * usedRatio * volumeRatio),
          skipped: Math.floor(
            Math.random() * 1000 * (1 - usedRatio) * volumeRatio
          ),
        });
      }
    });
    return usage;
  }, [features, mock, data?.usage]);

  // Update usage data every 10 seconds
  useEffect(() => {
    if (!update) return;
    let timer = 0;
    const cb = async () => {
      await mutate();
      timer = window.setTimeout(cb, 10000);
    };
    timer = window.setTimeout(cb, 10000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [update]);

  const max = useMemo(() => {
    return Math.max(
      1,
      ...Object.values(usage).map((d) => {
        return Math.max(1, ...d.realtime.map((u) => u.used + u.skipped));
      })
    );
  }, [usage]);

  return { usage, usageDomain: [0, max] };
}

export function getDefaultOperator(attribute: AttributeData) {
  if (attribute.datatype === "boolean") {
    return "$true";
  } else if (attribute.array) {
    return "$includes";
  } else if (attribute.disableEqualityConditions) {
    return "$regex";
  }
  return "$eq";
}

export function genDuplicatedKey({ id }: FeatureInterface) {
  try {
    // Take the '_4' out of 'feature_a_4'
    const numSuffix = id.match(/_[\d]+$/)?.[0];
    // Store 'feature_a' from 'feature_a_4'
    const keyRoot = numSuffix
      ? id.substring(0, id.length - numSuffix.length)
      : id;
    // Parse the 4 (number) out of '_4' (string)
    const num =
      (numSuffix ? parseInt(numSuffix.match(/[\d]+/)?.[0] || "0") : 0) + 1;

    return `${keyRoot}_${num}`;
  } catch (e) {
    // we failed, let the user name the key
    return "";
  }
}

export function getNewDraftExperimentsToPublish({
  environments,
  feature,
  revision,
  experimentsMap,
}: {
  feature: FeatureInterface;
  revision: FeatureRevisionInterface;
  environments: Environment[];
  experimentsMap: Map<string, ExperimentInterfaceStringDates>;
}) {
  const environmentIds = environments.map((e) => e.id);

  const liveExperimentIds = new Set(
    getMatchingRules(
      feature,
      (rule) => rule.type === "experiment-ref",
      environmentIds
    ).map((result) => (result.rule as ExperimentRefRule).experimentId)
  );

  function isExp(
    exp: ExperimentInterfaceStringDates | undefined
  ): exp is ExperimentInterfaceStringDates {
    return !!exp;
  }

  const draftExperiments = getMatchingRules(
    feature,
    (rule) => {
      if (rule.enabled === false) return false;
      if (rule.type !== "experiment-ref") return false;

      const exp = experimentsMap.get(rule.experimentId);
      if (!exp) return false;

      // Skip experiment rules that are already live
      if (liveExperimentIds.has(rule.experimentId)) return false;

      if (exp.status !== "draft") return false;
      if (exp.archived) return false;

      // Skip experiments with visual changesets. Those need to be started from the experiment page
      if (exp.hasVisualChangesets) return false;

      return true;
    },
    environmentIds,
    revision
  )
    .map((result) =>
      experimentsMap.get((result.rule as ExperimentRefRule).experimentId)
    )
    .filter(isExp);

  return [...new Set(draftExperiments)];
}

export function useFeatureExperimentChecklists({
  feature,
  revision,
  experimentsMap,
}: {
  feature: FeatureInterface;
  revision?: FeatureRevisionInterface;
  experimentsMap: Map<string, ExperimentInterfaceStringDates>;
}) {
  const allEnvironments = useEnvironments();

  const { data: checklistData } = useApi<{
    checklist: ExperimentLaunchChecklistInterface;
  }>("/experiments/launch-checklist");

  const settings = useOrgSettings();
  const orgStickyBucketing = !!settings.useStickyBucketing;

  const { data: sdkConnectionsData } = useSDKConnections();
  const connections = sdkConnectionsData?.connections || [];

  const experimentData = useMemo(() => {
    const experimentsAvailableToPublish = revision
      ? getNewDraftExperimentsToPublish({
          feature,
          revision,
          environments: allEnvironments,
          experimentsMap,
        })
      : [];

    const experimentData: {
      checklist: CheckListItem[];
      experiment: ExperimentInterfaceStringDates;
      failedRequired: boolean;
    }[] = [];
    experimentsAvailableToPublish.forEach((exp) => {
      const projectConnections = connections.filter(
        (connection) =>
          !connection.projects.length ||
          connection.projects.includes(exp.project || "")
      );

      const checklist = getChecklistItems({
        experiment: exp,
        linkedFeatures: [],
        visualChangesets: [],
        checklist: checklistData?.checklist,
        usingStickyBucketing: orgStickyBucketing && !exp.disableStickyBucketing,
        checkLinkedChanges: false,
        connections: projectConnections,
      });

      const failedRequired = checklist.some(
        (item) => item.status === "incomplete" && item.required
      );

      experimentData.push({ checklist, experiment: exp, failedRequired });
    });

    return experimentData;
  }, [
    connections,
    allEnvironments,
    orgStickyBucketing,
    checklistData,
    revision,
  ]);

  return {
    experimentData,
  };
}
