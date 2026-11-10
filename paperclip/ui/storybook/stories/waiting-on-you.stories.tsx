import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PendingHumanInputItem } from "@paperclipai/shared";
import { WaitingOnYouPanel } from "@/components/WaitingOnYouPanel";

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">{children}</main>
    </div>
  );
}

const geordi = {
  id: "agent-geordi",
  name: "Geordi La Forge",
  avatarUrl: null,
};

const data: PendingHumanInputItem = {
  id: "approval-1",
  source: "approval",
  kind: "approval",
  issue: { id: "issue-69", identifier: "ACME-69", title: "Ship the widget review" },
  message: "The ticket looks done to me — is it good to approve, or should it go back?",
  acceptLabel: "Approve",
  rejectLabel: "Reject",
  canResolveInline: true,
  requestingAgent: geordi,
  createdAt: "2026-07-10T09:00:00.000Z",
};

const planConfirmation: PendingHumanInputItem = {
  id: "interaction-plan",
  source: "interaction",
  kind: "request_confirmation",
  issue: { id: "issue-420", identifier: "ACME-420", title: "Rework the onboarding flow" },
  message: "Is this plan good? I'll start implementing once you confirm.",
  acceptLabel: "Approve plan",
  rejectLabel: "Request changes",
  canResolveInline: true,
  requestingAgent: { id: "agent-data", name: "Data", avatarUrl: null },
  createdAt: "2026-07-11T14:30:00.000Z",
};

const questions: PendingHumanInputItem = {
  id: "interaction-questions",
  source: "interaction",
  kind: "ask_user_questions",
  issue: { id: "issue-88", identifier: "ACME-88", title: "Pick a caching strategy" },
  message: "Which caching approach should I use? A couple of trade-offs to weigh.",
  acceptLabel: "Send answers",
  rejectLabel: null,
  canResolveInline: false,
  requestingAgent: { id: "agent-worf", name: "Worf", avatarUrl: null },
  createdAt: "2026-07-12T08:15:00.000Z",
};

const unlinkedApproval: PendingHumanInputItem = {
  id: "approval-hire",
  source: "approval",
  kind: "approval",
  issue: null,
  message: "Approve the hire of a new QA Verifier for the platform crew?",
  acceptLabel: "Approve",
  rejectLabel: "Reject",
  canResolveInline: true,
  requestingAgent: { id: "agent-riker", name: "Riker", avatarUrl: null },
  createdAt: "2026-07-12T10:45:00.000Z",
};

const allItems = [data, planConfirmation, questions, unlinkedApproval];

const meta = {
  title: "Control Plane/Waiting On You",
  parameters: {
    docs: {
      description: {
        component:
          "Dashboard table of every request currently awaiting the human board user — pending approvals and pending issue-thread interactions. Inline accept/reject for approvals and confirmations; requests needing structured input (questions, suggested tasks, checkbox options) open the ticket to resolve.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const MixedRequests: Story = {
  render: () => (
    <StoryFrame>
      <WaitingOnYouPanel
        items={allItems}
        onAccept={(item) => {
          console.log("accept", item.id);
        }}
        onReject={(item) => {
          console.log("reject", item.id);
        }}
      />
    </StoryFrame>
  ),
};

export const SingleApproval: Story = {
  render: () => (
    <StoryFrame>
      <WaitingOnYouPanel
        items={[data]}
        onAccept={() => {}}
        onReject={() => {}}
      />
    </StoryFrame>
  ),
};
