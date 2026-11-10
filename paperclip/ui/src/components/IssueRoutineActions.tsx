import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Loader2, Play } from "lucide-react";
import type { RoutineListItem, RoutineVariable } from "@paperclipai/shared";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { routinesApi } from "../api/routines";
import { queryKeys } from "../lib/queryKeys";

/**
 * Routines that declare a variable with this name are surfaced as one-click
 * actions on the issue detail page; firing one passes the current issue's
 * identifier as that variable. This is how manual-only routines (no triggers)
 * get a per-ticket entry point — e.g. an on-demand "Write repro steps" routine.
 *
 * Routines whose only variable is the issue identifier fire immediately.
 * Routines that declare additional variables (e.g. the crew-retrospective
 * routine's satisfaction score + feedback) open a small variables dialog with
 * the identifier prefilled, and run on submit.
 */
export const ISSUE_CONTEXT_ROUTINE_VARIABLE = "issueIdentifier";

export function isIssueContextRoutine(routine: RoutineListItem): boolean {
  return (
    routine.status === "active" &&
    (routine.variables ?? []).some((variable) => variable.name === ISSUE_CONTEXT_ROUTINE_VARIABLE)
  );
}

/** "Write repro steps — {{issueIdentifier}}" → "Write repro steps". */
export function issueRoutineActionLabel(title: string): string {
  const cut = title.indexOf("{{");
  const base = (cut === -1 ? title : title.slice(0, cut)).replace(/[\s—–:-]+$/u, "").trim();
  return base || title.trim();
}

/** Variables the operator still has to provide — everything but the prefilled identifier. */
function extraRoutineVariables(routine: RoutineListItem): RoutineVariable[] {
  return (routine.variables ?? []).filter(
    (variable) => variable.name !== ISSUE_CONTEXT_ROUTINE_VARIABLE,
  );
}

export interface IssueRoutineActionsProps {
  companyId: string;
  issueIdentifier: string;
}

/**
 * One compact button per active issue-context routine. Renders nothing when
 * the company has no such routines, so it costs no space in the header row.
 */
export function IssueRoutineActions({ companyId, issueIdentifier }: IssueRoutineActionsProps) {
  const { data: routines } = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
    staleTime: 60_000,
  });
  const [firedId, setFiredId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [dialogRoutine, setDialogRoutine] = useState<RoutineListItem | null>(null);
  const [dialogValues, setDialogValues] = useState<Record<string, string | number | boolean>>({});
  const runRoutine = useMutation({
    mutationFn: (input: { routineId: string; variables: Record<string, string | number | boolean> }) =>
      routinesApi.run(input.routineId, { variables: input.variables }),
    onSuccess: (_run, input) => {
      setFailedId(null);
      setDialogRoutine(null);
      setFiredId(input.routineId);
      window.setTimeout(
        () => setFiredId((current) => (current === input.routineId ? null : current)),
        4000,
      );
    },
    onError: (_error, input) => setFailedId(input.routineId),
  });

  const actionable = (routines ?? []).filter(isIssueContextRoutine);
  if (actionable.length === 0) return null;

  const dialogExtras = dialogRoutine ? extraRoutineVariables(dialogRoutine) : [];
  const missingRequired = dialogExtras.some(
    (variable) =>
      variable.required &&
      (dialogValues[variable.name] === "" || dialogValues[variable.name] == null),
  );

  const submitDialog = () => {
    if (!dialogRoutine) return;
    // Drop untouched optional fields so the run only carries entered values.
    const entered = Object.fromEntries(
      Object.entries(dialogValues).filter(([, value]) => value !== ""),
    );
    runRoutine.mutate({
      routineId: dialogRoutine.id,
      variables: { ...entered, [ISSUE_CONTEXT_ROUTINE_VARIABLE]: issueIdentifier },
    });
  };

  return (
    <>
      <span className="mr-1 flex items-center gap-1">
        {actionable.map((routine) => {
          const pending = runRoutine.isPending && runRoutine.variables?.routineId === routine.id;
          const fired = firedId === routine.id;
          const failed = failedId === routine.id;
          const label = issueRoutineActionLabel(routine.title);
          return (
            <Button
              key={routine.id}
              variant="ghost"
              size="xs"
              className={
                failed
                  ? "shrink-0 text-destructive hover:text-destructive"
                  : "shrink-0 text-muted-foreground hover:text-foreground"
              }
              disabled={pending || fired}
              onClick={() => {
                const extras = extraRoutineVariables(routine);
                if (extras.length > 0) {
                  setDialogValues(
                    Object.fromEntries(extras.map((variable) => [variable.name, variable.defaultValue ?? ""])),
                  );
                  setDialogRoutine(routine);
                } else {
                  runRoutine.mutate({
                    routineId: routine.id,
                    variables: { [ISSUE_CONTEXT_ROUTINE_VARIABLE]: issueIdentifier },
                  });
                }
              }}
              title={`Run "${label}" for ${issueIdentifier}`}
            >
              {pending ? (
                <Loader2 className="animate-spin" />
              ) : fired ? (
                <Check className="text-green-500" />
              ) : (
                <Play />
              )}
              {fired ? "Queued" : failed ? "Failed — retry" : label}
            </Button>
          );
        })}
      </span>
      {dialogRoutine ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDialogRoutine(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {issueRoutineActionLabel(dialogRoutine.title)} — {issueIdentifier}
              </DialogTitle>
              <DialogDescription>
                The ticket is prefilled; fill in the remaining variables.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {dialogExtras.map((variable) => (
                <div key={variable.name} className="space-y-1.5">
                  <Label className="text-xs">
                    {variable.label || variable.name}
                    {variable.required ? " *" : ""}
                  </Label>
                  {variable.type === "textarea" ? (
                    <Textarea
                      rows={4}
                      value={
                        typeof dialogValues[variable.name] === "string"
                          ? (dialogValues[variable.name] as string)
                          : ""
                      }
                      onChange={(event) =>
                        setDialogValues((current) => ({ ...current, [variable.name]: event.target.value }))
                      }
                    />
                  ) : variable.type === "select" ? (
                    <Select
                      value={
                        typeof dialogValues[variable.name] === "string" && dialogValues[variable.name]
                          ? (dialogValues[variable.name] as string)
                          : "__unset__"
                      }
                      onValueChange={(next) =>
                        setDialogValues((current) => ({
                          ...current,
                          [variable.name]: next === "__unset__" ? "" : next,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a value" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unset__">No value</SelectItem>
                        {variable.options.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : variable.type === "boolean" ? (
                    <Select
                      value={
                        dialogValues[variable.name] === true
                          ? "true"
                          : dialogValues[variable.name] === false
                            ? "false"
                            : "__unset__"
                      }
                      onValueChange={(next) =>
                        setDialogValues((current) => ({
                          ...current,
                          [variable.name]: next === "__unset__" ? "" : next === "true",
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unset__">No value</SelectItem>
                        <SelectItem value="true">True</SelectItem>
                        <SelectItem value="false">False</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      type={variable.type === "date" ? "date" : "text"}
                      value={dialogValues[variable.name] == null ? "" : String(dialogValues[variable.name])}
                      onChange={(event) =>
                        setDialogValues((current) => ({ ...current, [variable.name]: event.target.value }))
                      }
                    />
                  )}
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialogRoutine(null)}>
                Cancel
              </Button>
              <Button disabled={missingRequired || runRoutine.isPending} onClick={submitDialog}>
                {runRoutine.isPending ? <Loader2 className="animate-spin" /> : null}
                Run routine
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
