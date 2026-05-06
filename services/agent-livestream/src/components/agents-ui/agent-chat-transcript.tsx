'use client';

import { type ComponentProps } from 'react';
import { type AgentState } from '../../hooks/use-conversation.js';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { AgentChatIndicator } from '@/components/agents-ui/agent-chat-indicator';
import { AnimatePresence } from 'motion/react';
import type { MessageRow } from '@skill-networks/contracts/chat';

export interface AgentChatTranscriptProps extends ComponentProps<'div'> {
  agentState?: AgentState;
  messages?: MessageRow[];
  className?: string;
}

export function AgentChatTranscript({
  agentState,
  messages = [],
  className,
  ...props
}: AgentChatTranscriptProps) {
  return (
    <Conversation data-testid="conversation-view" className={className} {...props}>
      <ConversationContent>
        {messages.map((row) => {
          const time = new Date(row.createdAt);
          const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
          const title = time.toLocaleTimeString(locale, { timeStyle: 'short' });

          return (
            <Message key={row.id} title={title} from={row.role === 'user' ? 'user' : 'assistant'} data-role={row.role}>
              <MessageContent>
                <MessageResponse>{row.content}</MessageResponse>
              </MessageContent>
            </Message>
          );
        })}
        <AnimatePresence>
          {agentState === 'thinking' && <AgentChatIndicator size="sm" />}
        </AnimatePresence>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
