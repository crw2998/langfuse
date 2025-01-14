import { prisma } from "@langfuse/shared/src/db";

import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { createAuthedAPIRoute } from "@/src/features/public-api/server/createAuthedAPIRoute";
import { Prisma, type ObservationView } from "@langfuse/shared/src/db";

import { InternalServerError } from "@langfuse/shared";
import {
  GetObservationsV1Query,
  GetObservationsV1Response,
  transformDbToApiObservation,
} from "@/src/features/public-api/types/observations";
import { measureAndReturnApi } from "@/src/server/utils/checkClickhouseAccess";
import {
  generateObservationsForPublicApi,
  getObservationsCountForPublicApi,
} from "@/src/features/public-api/server/observations";

export default withMiddlewares({
  GET: createAuthedAPIRoute({
    name: "Get Observations",
    querySchema: GetObservationsV1Query,
    responseSchema: GetObservationsV1Response,
    fn: async ({ query, auth }) => {
      return await measureAndReturnApi({
        input: { projectId: auth.scope.projectId, queryClickhouse: false },
        operation: "api/public/observations",
        user: null,
        pgExecution: async () => {
          const userIdCondition = query.userId
            ? Prisma.sql`AND traces."user_id" = ${query.userId}`
            : Prisma.empty;

          const nameCondition = query.name
            ? Prisma.sql`AND o."name" = ${query.name}`
            : Prisma.empty;

          const observationTypeCondition = query.type
            ? Prisma.sql`AND o."type" = ${query.type}::"ObservationType"`
            : Prisma.empty;

          const traceIdCondition = query.traceId
            ? Prisma.sql`AND o."trace_id" = ${query.traceId}`
            : Prisma.empty;

          const parentObservationIdCondition = query.parentObservationId
            ? Prisma.sql`AND o."parent_observation_id" = ${query.parentObservationId}`
            : Prisma.empty;

          const fromStartTimeCondition = query.fromStartTime
            ? Prisma.sql`AND o."start_time" >= ${query.fromStartTime}::timestamp with time zone at time zone 'UTC'`
            : Prisma.empty;

          const toStartTimeCondition = query.toStartTime
            ? Prisma.sql`AND o."start_time" < ${query.toStartTime}::timestamp with time zone at time zone 'UTC'`
            : Prisma.empty;

          const versionCondition = query.version
            ? Prisma.sql`AND o."version" = ${query.version}`
            : Prisma.empty;

          const observations = await prisma.$queryRaw<ObservationView[]>`
          SELECT 
            o."id",
            o."name",
            o."start_time" AS "startTime",
            o."end_time" AS "endTime",
            o."parent_observation_id" AS "parentObservationId",
            o."type",
            o."metadata",
            o."model",
            o."input",
            o."output",
            o."level",
            o."status_message" AS "statusMessage",
            o."completion_start_time" AS "completionStartTime",
            o."completion_tokens" AS "completionTokens",
            o."prompt_tokens" AS "promptTokens",
            o."total_tokens" AS "totalTokens",
            o."unit" AS "unit",
            o."version",
            o."project_id" AS "projectId",
            o."trace_id" AS "traceId",
            o."modelParameters" AS "modelParameters",
            o."model_id" as "modelId",
            o."input_price" as "inputPrice",
            o."output_price" as "outputPrice",
            o."total_price" as "totalPrice",
            o."calculated_input_cost" as "calculatedInputCost",
            o."calculated_output_cost" as "calculatedOutputCost",
            o."calculated_total_cost" as "calculatedTotalCost",
            o."latency",
            o."prompt_id" as "promptId",
            o."prompt_name" as "promptName",
            o."prompt_version" as "promptVersion",
            o."created_at" as "createdAt",
            o."updated_at" as "updatedAt",
            o."time_to_first_token" as "timeToFirstToken"
          FROM observations_view o LEFT JOIN traces ON o."trace_id" = traces."id" AND traces."project_id" = o."project_id"
          WHERE o."project_id" = ${auth.scope.projectId}
          ${nameCondition}
          ${userIdCondition}
          ${observationTypeCondition}
          ${traceIdCondition}
          ${versionCondition}
          ${parentObservationIdCondition}
          ${fromStartTimeCondition}
          ${toStartTimeCondition}
          ORDER by o."start_time" DESC
          OFFSET ${(query.page - 1) * query.limit}
          LIMIT ${query.limit}
        `;
          const countRes = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) FROM observations o LEFT JOIN traces ON o."trace_id" = traces."id"
          WHERE o."project_id" = ${auth.scope.projectId}
          ${observationTypeCondition}
          ${nameCondition}
          ${userIdCondition}
          ${traceIdCondition}
          ${versionCondition}
          ${parentObservationIdCondition}
          ${fromStartTimeCondition}
          ${toStartTimeCondition}
      `;
          if (countRes.length !== 1) {
            throw new InternalServerError("Unexpected totalItems result");
          }
          const totalItems = Number(countRes[0].count);

          return {
            data: observations.map(transformDbToApiObservation),
            meta: {
              page: query.page,
              limit: query.limit,
              totalItems,
              totalPages: Math.ceil(totalItems / query.limit),
            },
          };
        },
        clickhouseExecution: async () => {
          const [items, count] = await Promise.all([
            generateObservationsForPublicApi({
              projectId: auth.scope.projectId,
              page: query.page ?? undefined,
              limit: query.limit ?? undefined,
              traceId: query.traceId ?? undefined,
              userId: query.userId ?? undefined,
              name: query.name ?? undefined,
              type: query.type ?? undefined,
              parentObservationId: query.parentObservationId ?? undefined,
              fromStartTime: query.fromStartTime ?? undefined,
              toStartTime: query.toStartTime ?? undefined,
              version: query.version ?? undefined,
            }),
            getObservationsCountForPublicApi({
              projectId: auth.scope.projectId,
              page: query.page ?? undefined,
              limit: query.limit ?? undefined,
              traceId: query.traceId ?? undefined,
              userId: query.userId ?? undefined,
              name: query.name ?? undefined,
              type: query.type ?? undefined,
              parentObservationId: query.parentObservationId ?? undefined,
              fromStartTime: query.fromStartTime ?? undefined,
              toStartTime: query.toStartTime ?? undefined,
              version: query.version ?? undefined,
            }),
          ]);
          const uniqueModels: string[] = Array.from(
            new Set(
              items
                .map((r) => r.modelId)
                .filter((r): r is string => Boolean(r)),
            ),
          );

          const models =
            uniqueModels.length > 0
              ? await prisma.model.findMany({
                  where: {
                    id: {
                      in: uniqueModels,
                    },
                    OR: [
                      { projectId: auth.scope.projectId },
                      { projectId: null },
                    ],
                  },
                  include: {
                    Price: true,
                  },
                })
              : [];

          return {
            data: items
              .map((i) => {
                const model = models.find((m) => m.id === i.modelId);
                return {
                  ...i,
                  modelId: model?.id ?? null,
                  inputPrice:
                    model?.Price?.find((m) => m.usageType === "input")?.price ??
                    null,
                  outputPrice:
                    model?.Price?.find((m) => m.usageType === "output")
                      ?.price ?? null,
                  totalPrice:
                    model?.Price?.find((m) => m.usageType === "total")?.price ??
                    null,
                };
              })
              .map(transformDbToApiObservation),
            meta: {
              page: query.page,
              limit: query.limit,
              totalItems: count ?? 0,
              totalPages: Math.ceil(count ?? 0 / query.limit),
            },
          };
        },
      });
    },
  }),
});
