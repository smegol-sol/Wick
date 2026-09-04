import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { IntentCard } from "@/components/intent-card";
import { PositionRow } from "@/components/position-row";
import { StatusStrip } from "@/components/status-strip";
import { Empty, Kicker } from "@/components/ui";
import { api, subscribe } from "@/lib/api";
import { useLang } from "@/lib/lang-context";

export function NowScreen() {
  const { t } = useLang();
  const qc = useQueryClient();
  const [online, setOnline] = useState(false);
  const state = useQuery({
    queryKey: ["state"],
    queryFn: api.state,
    refetchInterval: 15_000,
    retry: 1,
  });
  const intents = useQuery({
    queryKey: ["intents"],
    queryFn: () => api.intents(),
    refetchInterval: 10_000,
    retry: 1,
  });
  const positions = useQuery({
    queryKey: ["positions"],
    queryFn: api.positions,
    refetchInterval: 15_000,
    retry: 1,
  });

  useEffect(
    () =>
      subscribe(
        (m) => {
          if (m.type === "state") qc.setQueryData(["state"], m.state);
          if (m.type === "intent") void qc.invalidateQueries({ queryKey: ["intents"] });
          if (m.type === "position") void qc.invalidateQueries({ queryKey: ["positions"] });
        },
        (open) => setOnline(open),
      ),
    [qc],
  );

  const decide = useMutation({
    mutationFn: ({ id, ok }: { id: string; ok: boolean }) =>
      ok ? api.approve(id, { decidedBy: "owner" }) : api.reject(id, { decidedBy: "owner" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["intents"] });
      void qc.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const list = intents.data ?? [];
  const waiting = list.filter((v) => v.status === "proposed");
  const recent = list.filter((v) => v.status !== "proposed").slice(0, 6);
  const now = Date.now();

  return (
    <div className="flex flex-col gap-4">
      <StatusStrip state={state.data} online={online || state.isSuccess} />

      <section className="flex flex-col gap-2">
        <Kicker>
          {t("pending")} · {waiting.length}
        </Kicker>
        {intents.isError ? (
          <Empty>{t("offline")}</Empty>
        ) : waiting.length === 0 ? (
          <Empty>{t("noPending")}</Empty>
        ) : (
          waiting.map((v) => (
            <IntentCard
              key={v.intent.id}
              view={v}
              busy={decide.isPending}
              onApprove={(id) => decide.mutate({ id, ok: true })}
              onReject={(id) => decide.mutate({ id, ok: false })}
            />
          ))
        )}
        {decide.isError ? <p className="text-2xs text-down">{String(decide.error)}</p> : null}
      </section>

      <section className="flex flex-col gap-2">
        <Kicker>
          {t("positions")} · {positions.data?.length ?? 0}
        </Kicker>
        <div className="panel overflow-hidden">
          {(positions.data ?? []).length === 0 ? (
            <Empty>{t("noPositions")}</Empty>
          ) : (
            positions.data!.map((p) => (
              <PositionRow key={`${p.mint}:${p.openedAt}`} p={p} now={now} />
            ))
          )}
        </div>
      </section>

      {recent.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Kicker>{t("intents")}</Kicker>
          {recent.map((v) => (
            <IntentCard key={v.intent.id} view={v} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
