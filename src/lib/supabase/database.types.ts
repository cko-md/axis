export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_task_activity: {
        Row: {
          created_at: string
          detail: Json
          id: string
          kind: string
          task_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          detail?: Json
          id?: string
          kind: string
          task_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          detail?: Json
          id?: string
          kind?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_task_activity_owner_fkey"
            columns: ["task_id", "user_id"]
            isOneToOne: false
            referencedRelation: "agent_tasks"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "agent_task_activity_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "agent_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_tasks: {
        Row: {
          actual_cost_usd: number | null
          completed_at: string | null
          context: Json
          created_at: string
          estimated_cost_usd: number | null
          id: string
          idempotency_key: string | null
          objective: string
          source_routine_id: string | null
          source_skill: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          actual_cost_usd?: number | null
          completed_at?: string | null
          context?: Json
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          idempotency_key?: string | null
          objective: string
          source_routine_id?: string | null
          source_skill?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          actual_cost_usd?: number | null
          completed_at?: string | null
          context?: Json
          created_at?: string
          estimated_cost_usd?: number | null
          id?: string
          idempotency_key?: string | null
          objective?: string
          source_routine_id?: string | null
          source_skill?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_conversations: {
        Row: {
          created_at: string
          id: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_insights: {
        Row: {
          assumptions: string | null
          body: string
          confidence: string
          created_at: string
          data_used: Json | null
          dismissed: boolean
          id: string
          kind: string
          requires_review: boolean
          title: string
          user_id: string
        }
        Insert: {
          assumptions?: string | null
          body: string
          confidence?: string
          created_at?: string
          data_used?: Json | null
          dismissed?: boolean
          id?: string
          kind: string
          requires_review?: boolean
          title: string
          user_id: string
        }
        Update: {
          assumptions?: string | null
          body?: string
          confidence?: string
          created_at?: string
          data_used?: Json | null
          dismissed?: boolean
          id?: string
          kind?: string
          requires_review?: boolean
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_messages: {
        Row: {
          content: string | null
          conversation_id: string
          created_at: string
          id: string
          role: string
          tool_calls: Json | null
          user_id: string
        }
        Insert: {
          content?: string | null
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          tool_calls?: Json | null
          user_id: string
        }
        Update: {
          content?: string | null
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          tool_calls?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_tool_calls: {
        Row: {
          conversation_id: string | null
          created_at: string
          id: string
          input: Json | null
          latency_ms: number | null
          output: Json | null
          tool_name: string
          user_id: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          id?: string
          input?: Json | null
          latency_ms?: number | null
          output?: Json | null
          tool_name: string
          user_id: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          id?: string
          input?: Json | null
          latency_ms?: number | null
          output?: Json | null
          tool_name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_tool_calls_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      approvals: {
        Row: {
          action_class: string
          created_at: string
          decided_at: string | null
          expires_at: string | null
          id: string
          proposed_action: Json
          reasons: string[]
          requirement: string
          scope: string
          status: string
          step_up_verified_at: string | null
          task_id: string | null
          user_id: string
        }
        Insert: {
          action_class: string
          created_at?: string
          decided_at?: string | null
          expires_at?: string | null
          id?: string
          proposed_action: Json
          reasons?: string[]
          requirement: string
          scope?: string
          status?: string
          step_up_verified_at?: string | null
          task_id?: string | null
          user_id: string
        }
        Update: {
          action_class?: string
          created_at?: string
          decided_at?: string | null
          expires_at?: string | null
          id?: string
          proposed_action?: Json
          reasons?: string[]
          requirement?: string
          scope?: string
          status?: string
          step_up_verified_at?: string | null
          task_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "agent_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_task_owner_fkey"
            columns: ["task_id", "user_id"]
            isOneToOne: false
            referencedRelation: "agent_tasks"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      atelier_prefs: {
        Row: {
          pins: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          pins?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          pins?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor: string
          created_at: string
          id: string
          payload: Json | null
          result: string
          target_id: string | null
          target_table: string | null
          user_id: string
        }
        Insert: {
          action: string
          actor: string
          created_at?: string
          id?: string
          payload?: Json | null
          result?: string
          target_id?: string | null
          target_table?: string | null
          user_id: string
        }
        Update: {
          action?: string
          actor?: string
          created_at?: string
          id?: string
          payload?: Json | null
          result?: string
          target_id?: string | null
          target_table?: string | null
          user_id?: string
        }
        Relationships: []
      }
      board_fields: {
        Row: {
          field_key: string
          id: string
          updated_at: string
          user_id: string
          value: string
          view_key: string
        }
        Insert: {
          field_key: string
          id?: string
          updated_at?: string
          user_id: string
          value?: string
          view_key: string
        }
        Update: {
          field_key?: string
          id?: string
          updated_at?: string
          user_id?: string
          value?: string
          view_key?: string
        }
        Relationships: []
      }
      briefing_feeds: {
        Row: {
          created_at: string
          id: string
          name: string
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          url: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          url?: string
          user_id?: string
        }
        Relationships: []
      }
      briefing_saved_items: {
        Row: {
          id: string
          saved_at: string
          title: string
          type: string
          url: string
          user_id: string
        }
        Insert: {
          id?: string
          saved_at?: string
          title: string
          type?: string
          url: string
          user_id: string
        }
        Update: {
          id?: string
          saved_at?: string
          title?: string
          type?: string
          url?: string
          user_id?: string
        }
        Relationships: []
      }
      calendar_event_cache: {
        Row: {
          error: Json | null
          events: Json
          fetched_at: string
          range_end: string
          range_start: string
          source: string
          transport: string
          updated_at: string
          user_id: string
        }
        Insert: {
          error?: Json | null
          events?: Json
          fetched_at?: string
          range_end: string
          range_start: string
          source: string
          transport?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          error?: Json | null
          events?: Json
          fetched_at?: string
          range_end?: string
          range_start?: string
          source?: string
          transport?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      composio_connections: {
        Row: {
          account_label: string | null
          auth_config_id: string
          connected_account_id: string
          created_at: string
          id: string
          status: string
          toolkit: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_label?: string | null
          auth_config_id: string
          connected_account_id: string
          created_at?: string
          id?: string
          status?: string
          toolkit: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_label?: string | null
          auth_config_id?: string
          connected_account_id?: string
          created_at?: string
          id?: string
          status?: string
          toolkit?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      conferences: {
        Row: {
          abstract: string
          abstract_due_date: string | null
          created_at: string
          date_label: string
          id: string
          linked_study_id: string | null
          location: string
          name: string
          next_step: string
          status: string
          travel: string
          updated_at: string
          user_id: string
        }
        Insert: {
          abstract?: string
          abstract_due_date?: string | null
          created_at?: string
          date_label?: string
          id?: string
          linked_study_id?: string | null
          location?: string
          name: string
          next_step?: string
          status?: string
          travel?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          abstract?: string
          abstract_due_date?: string | null
          created_at?: string
          date_label?: string
          id?: string
          linked_study_id?: string | null
          location?: string
          name?: string
          next_step?: string
          status?: string
          travel?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conferences_linked_study_id_fkey"
            columns: ["linked_study_id"]
            isOneToOne: false
            referencedRelation: "studies"
            referencedColumns: ["id"]
          },
        ]
      }
      console_photos: {
        Row: {
          caption: string
          created_at: string
          id: string
          image_url: string
          sort_order: number
          user_id: string
        }
        Insert: {
          caption?: string
          created_at?: string
          id?: string
          image_url: string
          sort_order?: number
          user_id: string
        }
        Update: {
          caption?: string
          created_at?: string
          id?: string
          image_url?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: []
      }
      console_widgets: {
        Row: {
          created_at: string
          layout: Json
          sort_order: string[]
          updated_at: string
          user_id: string
          widget_ids: string[]
          widget_texts: Json
        }
        Insert: {
          created_at?: string
          layout?: Json
          sort_order?: string[]
          updated_at?: string
          user_id: string
          widget_ids?: string[]
          widget_texts?: Json
        }
        Update: {
          created_at?: string
          layout?: Json
          sort_order?: string[]
          updated_at?: string
          user_id?: string
          widget_ids?: string[]
          widget_texts?: Json
        }
        Relationships: []
      }
      debrief_entries: {
        Row: {
          calendar_event_ids: string[]
          challenges: string
          completed_task_ids: string[]
          created_at: string
          focus: string
          id: string
          metadata: Json
          missed_task_ids: string[]
          objective_ids: string[]
          review_date: string
          review_type: string
          summary: string
          updated_at: string
          user_id: string
          wins: string
        }
        Insert: {
          calendar_event_ids?: string[]
          challenges?: string
          completed_task_ids?: string[]
          created_at?: string
          focus?: string
          id?: string
          metadata?: Json
          missed_task_ids?: string[]
          objective_ids?: string[]
          review_date: string
          review_type?: string
          summary?: string
          updated_at?: string
          user_id: string
          wins?: string
        }
        Update: {
          calendar_event_ids?: string[]
          challenges?: string
          completed_task_ids?: string[]
          created_at?: string
          focus?: string
          id?: string
          metadata?: Json
          missed_task_ids?: string[]
          objective_ids?: string[]
          review_date?: string
          review_type?: string
          summary?: string
          updated_at?: string
          user_id?: string
          wins?: string
        }
        Relationships: []
      }
      entity_references: {
        Row: {
          created_at: string
          id: string
          label: string | null
          origin: string
          relation: string
          source_id: string
          source_kind: string
          target_id: string
          target_kind: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          origin?: string
          relation?: string
          source_id: string
          source_kind: string
          target_id: string
          target_kind: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          origin?: string
          relation?: string
          source_id?: string
          source_kind?: string
          target_id?: string
          target_kind?: string
          user_id?: string
        }
        Relationships: []
      }
      entity_usage: {
        Row: {
          command_count: number
          created_at: string
          direct_open_count: number
          entity_id: string
          entity_kind: string
          last_action: string
          last_command_at: string | null
          last_direct_open_at: string | null
          last_link_at: string | null
          last_search_select_at: string | null
          last_used_at: string
          link_count: number
          search_select_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          command_count?: number
          created_at?: string
          direct_open_count?: number
          entity_id: string
          entity_kind: string
          last_action: string
          last_command_at?: string | null
          last_direct_open_at?: string | null
          last_link_at?: string | null
          last_search_select_at?: string | null
          last_used_at?: string
          link_count?: number
          search_select_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          command_count?: number
          created_at?: string
          direct_open_count?: number
          entity_id?: string
          entity_kind?: string
          last_action?: string
          last_command_at?: string | null
          last_direct_open_at?: string | null
          last_link_at?: string | null
          last_search_select_at?: string | null
          last_used_at?: string
          link_count?: number
          search_select_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      feed_cache: {
        Row: {
          feed_url: string
          fetched_at: string
          items: Json
        }
        Insert: {
          feed_url: string
          fetched_at?: string
          items?: Json
        }
        Update: {
          feed_url?: string
          fetched_at?: string
          items?: Json
        }
        Relationships: []
      }
      financial_operating_profiles: {
        Row: {
          base_currency: string
          concentration_limit_bps: number
          confirmed_at: string
          constraints: string[]
          created_at: string
          investment_horizon: string
          liquidity_buffer_months: number
          priorities: string[]
          risk_posture: string
          source_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          base_currency?: string
          concentration_limit_bps?: number
          confirmed_at?: string
          constraints?: string[]
          created_at?: string
          investment_horizon?: string
          liquidity_buffer_months?: number
          priorities?: string[]
          risk_posture?: string
          source_type?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          base_currency?: string
          concentration_limit_bps?: number
          confirmed_at?: string
          constraints?: string[]
          created_at?: string
          investment_horizon?: string
          liquidity_buffer_months?: number
          priorities?: string[]
          risk_posture?: string
          source_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fitness_routine_exercises: {
        Row: {
          created_at: string
          id: string
          name: string
          reps: string | null
          rest: string | null
          routine_id: string
          sets: number | null
          sort_order: number
          updated_at: string
          user_id: string
          weight: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          reps?: string | null
          rest?: string | null
          routine_id: string
          sets?: number | null
          sort_order?: number
          updated_at?: string
          user_id: string
          weight?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          reps?: string | null
          rest?: string | null
          routine_id?: string
          sets?: number | null
          sort_order?: number
          updated_at?: string
          user_id?: string
          weight?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fitness_routine_exercises_routine_id_fkey"
            columns: ["routine_id"]
            isOneToOne: false
            referencedRelation: "fitness_routines"
            referencedColumns: ["id"]
          },
        ]
      }
      fitness_routines: {
        Row: {
          category: string
          created_at: string
          discipline: string
          id: string
          name: string
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string
          created_at?: string
          discipline?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          discipline?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fund_bank_transactions: {
        Row: {
          account_id: string | null
          amount: number
          authorized_date: string | null
          connection_id: string | null
          created_at: string
          custom_category: string | null
          excluded_from_budget: boolean
          id: string
          is_transfer: boolean
          iso_currency_code: string
          merchant_name: string | null
          notes: string | null
          pending: boolean
          plaid_category: string | null
          plaid_transaction_id: string
          posted_date: string
          raw_name: string | null
          retrieved_at: string | null
          reviewed: boolean
          split_parent_id: string | null
          tags: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          amount?: number
          authorized_date?: string | null
          connection_id?: string | null
          created_at?: string
          custom_category?: string | null
          excluded_from_budget?: boolean
          id?: string
          is_transfer?: boolean
          iso_currency_code?: string
          merchant_name?: string | null
          notes?: string | null
          pending?: boolean
          plaid_category?: string | null
          plaid_transaction_id: string
          posted_date: string
          raw_name?: string | null
          retrieved_at?: string | null
          reviewed?: boolean
          split_parent_id?: string | null
          tags?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          account_id?: string | null
          amount?: number
          authorized_date?: string | null
          connection_id?: string | null
          created_at?: string
          custom_category?: string | null
          excluded_from_budget?: boolean
          id?: string
          is_transfer?: boolean
          iso_currency_code?: string
          merchant_name?: string | null
          notes?: string | null
          pending?: boolean
          plaid_category?: string | null
          plaid_transaction_id?: string
          posted_date?: string
          raw_name?: string | null
          retrieved_at?: string | null
          reviewed?: boolean
          split_parent_id?: string | null
          tags?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fund_bank_transactions_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "fund_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fund_bank_transactions_split_parent_id_fkey"
            columns: ["split_parent_id"]
            isOneToOne: false
            referencedRelation: "fund_bank_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_category_budgets: {
        Row: {
          category: string
          created_at: string
          id: string
          monthly_limit: number
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          monthly_limit?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          monthly_limit?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fund_connections: {
        Row: {
          access_token_enc: string | null
          created_at: string
          id: string
          institution: string | null
          item_id: string | null
          mask: string | null
          provider: string
          refresh_token_enc: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_enc?: string | null
          created_at?: string
          id?: string
          institution?: string | null
          item_id?: string | null
          mask?: string | null
          provider: string
          refresh_token_enc?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_enc?: string | null
          created_at?: string
          id?: string
          institution?: string | null
          item_id?: string | null
          mask?: string | null
          provider?: string
          refresh_token_enc?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fund_holdings: {
        Row: {
          connection_id: string | null
          cost_basis: number
          created_at: string
          currency: string
          effective_at: string | null
          id: string
          name: string
          provider: string | null
          provider_record_id: string | null
          reconciliation_state: string | null
          retrieved_at: string | null
          shares: number
          sort_order: number
          source: string
          symbol: string
          updated_at: string
          user_id: string
        }
        Insert: {
          connection_id?: string | null
          cost_basis?: number
          created_at?: string
          currency?: string
          effective_at?: string | null
          id?: string
          name: string
          provider?: string | null
          provider_record_id?: string | null
          reconciliation_state?: string | null
          retrieved_at?: string | null
          shares?: number
          sort_order?: number
          source?: string
          symbol: string
          updated_at?: string
          user_id: string
        }
        Update: {
          connection_id?: string | null
          cost_basis?: number
          created_at?: string
          currency?: string
          effective_at?: string | null
          id?: string
          name?: string
          provider?: string | null
          provider_record_id?: string | null
          reconciliation_state?: string | null
          retrieved_at?: string | null
          shares?: number
          sort_order?: number
          source?: string
          symbol?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fund_holdings_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "fund_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_liabilities: {
        Row: {
          apr: number | null
          balance: number
          connection_id: string | null
          created_at: string
          currency: string
          due_date: string | null
          effective_at: string | null
          id: string
          kind: string
          minimum_payment: number | null
          name: string
          provider: string | null
          provider_record_id: string | null
          reconciliation_state: string | null
          retrieved_at: string | null
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          apr?: number | null
          balance?: number
          connection_id?: string | null
          created_at?: string
          currency?: string
          due_date?: string | null
          effective_at?: string | null
          id?: string
          kind?: string
          minimum_payment?: number | null
          name: string
          provider?: string | null
          provider_record_id?: string | null
          reconciliation_state?: string | null
          retrieved_at?: string | null
          source?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          apr?: number | null
          balance?: number
          connection_id?: string | null
          created_at?: string
          currency?: string
          due_date?: string | null
          effective_at?: string | null
          id?: string
          kind?: string
          minimum_payment?: number | null
          name?: string
          provider?: string | null
          provider_record_id?: string | null
          reconciliation_state?: string | null
          retrieved_at?: string | null
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fund_liabilities_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "fund_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_recurring_transactions: {
        Row: {
          cadence: string
          category: string | null
          created_at: string
          expected_amount: number
          id: string
          last_seen_date: string | null
          merchant_name: string
          next_expected_date: string | null
          source: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cadence?: string
          category?: string | null
          created_at?: string
          expected_amount?: number
          id?: string
          last_seen_date?: string | null
          merchant_name: string
          next_expected_date?: string | null
          source?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cadence?: string
          category?: string | null
          created_at?: string
          expected_amount?: number
          id?: string
          last_seen_date?: string | null
          merchant_name?: string
          next_expected_date?: string | null
          source?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fund_transactions: {
        Row: {
          amount: number
          created_at: string
          currency: string
          executed_at: string
          fee: number
          id: string
          kind: string
          name: string | null
          note: string | null
          price: number
          provider_record_id: string | null
          reconciliation_state: string | null
          retrieved_at: string | null
          shares: number
          source: string
          symbol: string | null
          user_id: string
        }
        Insert: {
          amount?: number
          created_at?: string
          currency?: string
          executed_at?: string
          fee?: number
          id?: string
          kind?: string
          name?: string | null
          note?: string | null
          price?: number
          provider_record_id?: string | null
          reconciliation_state?: string | null
          retrieved_at?: string | null
          shares?: number
          source?: string
          symbol?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          executed_at?: string
          fee?: number
          id?: string
          kind?: string
          name?: string | null
          note?: string | null
          price?: number
          provider_record_id?: string | null
          reconciliation_state?: string | null
          retrieved_at?: string | null
          shares?: number
          source?: string
          symbol?: string | null
          user_id?: string
        }
        Relationships: []
      }
      fund_watchlist: {
        Row: {
          created_at: string
          id: string
          name: string
          sort_order: number
          symbol: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          symbol: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      gallery_favorites: {
        Row: {
          created_at: string | null
          id: string
          item_id: string
          item_type: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          item_id: string
          item_type: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          item_id?: string
          item_type?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      game_achievements: {
        Row: {
          achievement_id: string
          created_at: string
          game_id: string
          id: string
          source_event_id: string
          unlocked_at: string
          user_id: string
        }
        Insert: {
          achievement_id: string
          created_at?: string
          game_id: string
          id?: string
          source_event_id: string
          unlocked_at: string
          user_id: string
        }
        Update: {
          achievement_id?: string
          created_at?: string
          game_id?: string
          id?: string
          source_event_id?: string
          unlocked_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_achievements_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "game_events"
            referencedColumns: ["id"]
          },
        ]
      }
      game_events: {
        Row: {
          client_revision: number
          created_at: string
          device_id: string
          event_kind: string
          game_id: string
          id: string
          idempotency_key: string
          occurred_at: string
          outcome: Json | null
          payload_hash: string
          request_payload: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          client_revision: number
          created_at?: string
          device_id: string
          event_kind: string
          game_id: string
          id?: string
          idempotency_key: string
          occurred_at: string
          outcome?: Json | null
          payload_hash: string
          request_payload?: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          client_revision?: number
          created_at?: string
          device_id?: string
          event_kind?: string
          game_id?: string
          id?: string
          idempotency_key?: string
          occurred_at?: string
          outcome?: Json | null
          payload_hash?: string
          request_payload?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      game_profiles: {
        Row: {
          counters: Json
          created_at: string
          last_device_id: string | null
          profile_version: number
          server_revision: number
          setting_clocks: Json
          settings: Json
          unlocks: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          counters?: Json
          created_at?: string
          last_device_id?: string | null
          profile_version?: number
          server_revision?: number
          setting_clocks?: Json
          settings?: Json
          unlocks?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          counters?: Json
          created_at?: string
          last_device_id?: string | null
          profile_version?: number
          server_revision?: number
          setting_clocks?: Json
          settings?: Json
          unlocks?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      game_save_conflicts: {
        Row: {
          conflict_version: number
          created_at: string
          game_id: string
          id: string
          local_checksum: string
          local_device_id: string
          local_game_version: string
          local_revision: number
          local_save_schema_version: number
          local_seed: string | null
          local_state: Json
          local_updated_at: string
          reason: string
          resolution: string | null
          resolved_at: string | null
          resolved_event_id: string | null
          server_checksum: string | null
          server_game_version: string | null
          server_revision: number
          server_save_schema_version: number | null
          server_seed: string | null
          server_state: Json | null
          server_updated_at: string | null
          slot_id: string
          source_event_id: string
          status: string
          user_id: string
        }
        Insert: {
          conflict_version?: number
          created_at?: string
          game_id: string
          id?: string
          local_checksum: string
          local_device_id: string
          local_game_version: string
          local_revision: number
          local_save_schema_version: number
          local_seed?: string | null
          local_state: Json
          local_updated_at: string
          reason: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_event_id?: string | null
          server_checksum?: string | null
          server_game_version?: string | null
          server_revision?: number
          server_save_schema_version?: number | null
          server_seed?: string | null
          server_state?: Json | null
          server_updated_at?: string | null
          slot_id: string
          source_event_id: string
          status?: string
          user_id: string
        }
        Update: {
          conflict_version?: number
          created_at?: string
          game_id?: string
          id?: string
          local_checksum?: string
          local_device_id?: string
          local_game_version?: string
          local_revision?: number
          local_save_schema_version?: number
          local_seed?: string | null
          local_state?: Json
          local_updated_at?: string
          reason?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_event_id?: string | null
          server_checksum?: string | null
          server_game_version?: string | null
          server_revision?: number
          server_save_schema_version?: number | null
          server_seed?: string | null
          server_state?: Json | null
          server_updated_at?: string | null
          slot_id?: string
          source_event_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_save_conflicts_resolved_event_id_fkey"
            columns: ["resolved_event_id"]
            isOneToOne: true
            referencedRelation: "game_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_save_conflicts_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: true
            referencedRelation: "game_events"
            referencedColumns: ["id"]
          },
        ]
      }
      game_saves: {
        Row: {
          checksum: string
          client_revision: number
          client_updated_at: string
          created_at: string
          deleted_at: string | null
          device_id: string
          game_id: string
          game_version: string
          id: string
          save_schema_version: number
          seed: string | null
          server_revision: number
          slot_id: string
          source_event_id: string
          state: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          checksum: string
          client_revision: number
          client_updated_at: string
          created_at?: string
          deleted_at?: string | null
          device_id: string
          game_id: string
          game_version: string
          id?: string
          save_schema_version: number
          seed?: string | null
          server_revision: number
          slot_id: string
          source_event_id: string
          state: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          checksum?: string
          client_revision?: number
          client_updated_at?: string
          created_at?: string
          deleted_at?: string | null
          device_id?: string
          game_id?: string
          game_version?: string
          id?: string
          save_schema_version?: number
          seed?: string | null
          server_revision?: number
          slot_id?: string
          source_event_id?: string
          state?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_saves_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "game_events"
            referencedColumns: ["id"]
          },
        ]
      }
      game_scores: {
        Row: {
          challenge_id: string | null
          challenge_key: string
          created_at: string
          game_id: string
          id: string
          mode: string
          score: number
          source_event_id: string
          updated_at: string
          user_id: string
          verification_status: string
        }
        Insert: {
          challenge_id?: string | null
          challenge_key: string
          created_at?: string
          game_id: string
          id?: string
          mode: string
          score: number
          source_event_id: string
          updated_at?: string
          user_id: string
          verification_status?: string
        }
        Update: {
          challenge_id?: string | null
          challenge_key?: string
          created_at?: string
          game_id?: string
          id?: string
          mode?: string
          score?: number
          source_event_id?: string
          updated_at?: string
          user_id?: string
          verification_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_scores_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "game_events"
            referencedColumns: ["id"]
          },
        ]
      }
      habit_checks: {
        Row: {
          checked_on: string
          created_at: string
          habit_id: string
          id: string
          user_id: string
        }
        Insert: {
          checked_on?: string
          created_at?: string
          habit_id: string
          id?: string
          user_id: string
        }
        Update: {
          checked_on?: string
          created_at?: string
          habit_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "habit_checks_habit_id_fkey"
            columns: ["habit_id"]
            isOneToOne: false
            referencedRelation: "habits"
            referencedColumns: ["id"]
          },
        ]
      }
      habits: {
        Row: {
          created_at: string
          icon: string
          id: string
          name: string
          sort_order: number
          user_id: string
        }
        Insert: {
          created_at?: string
          icon?: string
          id?: string
          name: string
          sort_order?: number
          user_id: string
        }
        Update: {
          created_at?: string
          icon?: string
          id?: string
          name?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: []
      }
      health_check_runs: {
        Row: {
          all_ok: boolean
          dependency_check: Json | null
          extra: Json | null
          id: string
          old_signals_deleted: Json | null
          overdue_tasks: Json | null
          ran_at: string
          supabase_health: Json | null
        }
        Insert: {
          all_ok?: boolean
          dependency_check?: Json | null
          extra?: Json | null
          id?: string
          old_signals_deleted?: Json | null
          overdue_tasks?: Json | null
          ran_at?: string
          supabase_health?: Json | null
        }
        Update: {
          all_ok?: boolean
          dependency_check?: Json | null
          extra?: Json | null
          id?: string
          old_signals_deleted?: Json | null
          overdue_tasks?: Json | null
          ran_at?: string
          supabase_health?: Json | null
        }
        Relationships: []
      }
      integration_delivery_outbox: {
        Row: {
          attempt_count: number
          claim_token: string | null
          created_at: string
          dedupe_key_hash: string
          delivered_at: string | null
          event_type: string
          id: string
          last_error_code: string | null
          last_http_status: number | null
          locked_at: string | null
          payload_ciphertext: string
          provider: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          claim_token?: string | null
          created_at?: string
          dedupe_key_hash: string
          delivered_at?: string | null
          event_type: string
          id?: string
          last_error_code?: string | null
          last_http_status?: number | null
          locked_at?: string | null
          payload_ciphertext: string
          provider: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          claim_token?: string | null
          created_at?: string
          dedupe_key_hash?: string
          delivered_at?: string | null
          event_type?: string
          id?: string
          last_error_code?: string | null
          last_http_status?: number | null
          locked_at?: string | null
          payload_ciphertext?: string
          provider?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      integration_sync_state: {
        Row: {
          account_label: string
          account_ref: string
          domain: string
          last_attempted_at: string
          last_error_code: string | null
          last_status: string
          last_synced_at: string | null
          provider: string
          sync_generation: string | null
          transport: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_label: string
          account_ref: string
          domain: string
          last_attempted_at: string
          last_error_code?: string | null
          last_status: string
          last_synced_at?: string | null
          provider: string
          sync_generation?: string | null
          transport: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_label?: string
          account_ref?: string
          domain?: string
          last_attempted_at?: string
          last_error_code?: string | null
          last_status?: string
          last_synced_at?: string | null
          provider?: string
          sync_generation?: string | null
          transport?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      key_result_progress: {
        Row: {
          created_at: string
          delta: number
          id: string
          key_result_id: string
          new_value: number
          previous_value: number
          source: string
          user_id: string
        }
        Insert: {
          created_at?: string
          delta: number
          id?: string
          key_result_id: string
          new_value: number
          previous_value: number
          source?: string
          user_id: string
        }
        Update: {
          created_at?: string
          delta?: number
          id?: string
          key_result_id?: string
          new_value?: number
          previous_value?: number
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "key_result_progress_key_result_id_fkey"
            columns: ["key_result_id"]
            isOneToOne: false
            referencedRelation: "key_results"
            referencedColumns: ["id"]
          },
        ]
      }
      key_results: {
        Row: {
          created_at: string
          current_value: number
          id: string
          objective_id: string
          sort_order: number
          target_value: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_value?: number
          id?: string
          objective_id: string
          sort_order?: number
          target_value?: number
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_value?: number
          id?: string
          objective_id?: string
          sort_order?: number
          target_value?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "key_results_objective_id_fkey"
            columns: ["objective_id"]
            isOneToOne: false
            referencedRelation: "objectives"
            referencedColumns: ["id"]
          },
        ]
      }
      library_files: {
        Row: {
          collection: number
          created_at: string | null
          display_name: string
          id: string
          mime_type: string | null
          size_bytes: number | null
          storage_path: string
          user_id: string
        }
        Insert: {
          collection?: number
          created_at?: string | null
          display_name: string
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path: string
          user_id: string
        }
        Update: {
          collection?: number
          created_at?: string | null
          display_name?: string
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path?: string
          user_id?: string
        }
        Relationships: []
      }
      literature_prefs: {
        Row: {
          custom_topics: Json
          last_query: string | null
          last_seen_ids: string[]
          topics: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          custom_topics?: Json
          last_query?: string | null
          last_seen_ids?: string[]
          topics?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          custom_topics?: Json
          last_query?: string | null
          last_seen_ids?: string[]
          topics?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      literature_saved: {
        Row: {
          article_id: string
          authors: string | null
          created_at: string
          id: string
          notes: string
          published_at: string | null
          source: string | null
          summary: string | null
          tags: string[]
          title: string
          url: string
          user_id: string
        }
        Insert: {
          article_id: string
          authors?: string | null
          created_at?: string
          id?: string
          notes?: string
          published_at?: string | null
          source?: string | null
          summary?: string | null
          tags?: string[]
          title: string
          url: string
          user_id: string
        }
        Update: {
          article_id?: string
          authors?: string | null
          created_at?: string
          id?: string
          notes?: string
          published_at?: string | null
          source?: string | null
          summary?: string | null
          tags?: string[]
          title?: string
          url?: string
          user_id?: string
        }
        Relationships: []
      }
      mail_message_cache: {
        Row: {
          account_email: string
          account_ref: string
          connected_account_id: string | null
          fetched_at: string
          is_unread: boolean
          message_date: string
          provider: string
          provider_message_id: string
          received_at: string | null
          sender: string
          snippet: string
          subject: string
          sync_generation: string
          thread_id: string
          transport: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_email: string
          account_ref: string
          connected_account_id?: string | null
          fetched_at?: string
          is_unread?: boolean
          message_date: string
          provider: string
          provider_message_id: string
          received_at?: string | null
          sender?: string
          snippet?: string
          subject?: string
          sync_generation: string
          thread_id?: string
          transport: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_email?: string
          account_ref?: string
          connected_account_id?: string | null
          fetched_at?: string
          is_unread?: boolean
          message_date?: string
          provider?: string
          provider_message_id?: string
          received_at?: string | null
          sender?: string
          snippet?: string
          subject?: string
          sync_generation?: string
          thread_id?: string
          transport?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      meal_logs: {
        Row: {
          emoji: string
          id: string
          logged_at: string
          macros: string
          timing: string
          title: string
          user_id: string
        }
        Insert: {
          emoji?: string
          id?: string
          logged_at?: string
          macros?: string
          timing?: string
          title: string
          user_id: string
        }
        Update: {
          emoji?: string
          id?: string
          logged_at?: string
          macros?: string
          timing?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      meditation_sessions: {
        Row: {
          duration_min: number
          id: string
          mood_after: number
          mood_before: number
          notes: string
          occurred_at: string
          type: string
          user_id: string
        }
        Insert: {
          duration_min: number
          id?: string
          mood_after: number
          mood_before: number
          notes?: string
          occurred_at?: string
          type: string
          user_id: string
        }
        Update: {
          duration_min?: number
          id?: string
          mood_after?: number
          mood_before?: number
          notes?: string
          occurred_at?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      memory_items: {
        Row: {
          archived_at: string | null
          confidence_bps: number
          content: string
          created_at: string
          expires_at: string | null
          id: string
          kind: string
          scope: string
          source_ref: string | null
          source_type: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          confidence_bps?: number
          content: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind: string
          scope: string
          source_ref?: string | null
          source_type?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          confidence_bps?: number
          content?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: string
          scope?: string
          source_ref?: string | null
          source_type?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      moodboard_images: {
        Row: {
          created_at: string
          id: string
          image_url: string
          sort_order: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_url: string
          sort_order?: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          image_url?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: []
      }
      net_worth_snapshots: {
        Row: {
          captured_on: string
          cash: number
          computed_at: string
          created_at: string
          id: string
          invested: number
          liabilities: number
          net_worth: number
          user_id: string
        }
        Insert: {
          captured_on?: string
          cash?: number
          computed_at?: string
          created_at?: string
          id?: string
          invested?: number
          liabilities?: number
          net_worth?: number
          user_id: string
        }
        Update: {
          captured_on?: string
          cash?: number
          computed_at?: string
          created_at?: string
          id?: string
          invested?: number
          liabilities?: number
          net_worth?: number
          user_id?: string
        }
        Relationships: []
      }
      note_artifacts: {
        Row: {
          created_at: string
          data: Json
          id: string
          note_id: string
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          note_id: string
          type: string
          user_id: string
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          note_id?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_artifacts_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      note_embeddings: {
        Row: {
          created_at: string | null
          embedding: string | null
          id: string
          note_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          embedding?: string | null
          id?: string
          note_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          embedding?: string | null
          id?: string
          note_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_embeddings_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: true
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          body: string
          created_at: string
          folder: string
          id: string
          sort_order: number
          tags: string[]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string
          created_at?: string
          folder?: string
          id?: string
          sort_order?: number
          tags?: string[]
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          folder?: string
          id?: string
          sort_order?: number
          tags?: string[]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      nutrition_protocol: {
        Row: {
          created_at: string
          diet_protocol: string
          hydration_current_l: number
          hydration_target_l: number
          notes: string | null
          protein_target_g_per_lb: number
          training_day_carb_bump_g: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          diet_protocol?: string
          hydration_current_l?: number
          hydration_target_l?: number
          notes?: string | null
          protein_target_g_per_lb?: number
          training_day_carb_bump_g?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          diet_protocol?: string
          hydration_current_l?: number
          hydration_target_l?: number
          notes?: string | null
          protein_target_g_per_lb?: number
          training_day_carb_bump_g?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      objectives: {
        Row: {
          created_at: string
          descriptor: string
          id: string
          sort_order: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          descriptor?: string
          id?: string
          sort_order?: number
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          descriptor?: string
          id?: string
          sort_order?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      people: {
        Row: {
          created_at: string
          follow_up_on: string | null
          id: string
          last_contact_on: string | null
          name: string
          note: string
          role: string
          tag: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          follow_up_on?: string | null
          id?: string
          last_contact_on?: string | null
          name: string
          note?: string
          role?: string
          tag?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          follow_up_on?: string | null
          id?: string
          last_contact_on?: string | null
          name?: string
          note?: string
          role?: string
          tag?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      pipeline_stages: {
        Row: {
          created_at: string
          id: string
          name: string
          sort_order: number
          swatch: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          swatch?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          swatch?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          ai_provider: string
          avatar_url: string | null
          bio: string | null
          created_at: string
          display_name: string | null
          id: string
          role_title: string | null
          theme: string
          updated_at: string
        }
        Insert: {
          ai_provider?: string
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          role_title?: string | null
          theme?: string
          updated_at?: string
        }
        Update: {
          ai_provider?: string
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          role_title?: string | null
          theme?: string
          updated_at?: string
        }
        Relationships: []
      }
      routine_runs: {
        Row: {
          actual_cost_usd: number | null
          approval_id: string | null
          completed_at: string | null
          created_at: string
          error: string | null
          estimated_cost_usd: number | null
          id: string
          idempotency_key: string | null
          input_snapshot: Json
          output: Json | null
          paused_step_key: string | null
          resume_attempt: number
          resume_claim_expires_at: string | null
          resume_claim_token: string | null
          resume_claimed_at: string | null
          routine_key: string
          routine_version: number
          started_at: string
          status: string
          trigger: string
          user_id: string
        }
        Insert: {
          actual_cost_usd?: number | null
          approval_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          estimated_cost_usd?: number | null
          id?: string
          idempotency_key?: string | null
          input_snapshot?: Json
          output?: Json | null
          paused_step_key?: string | null
          resume_attempt?: number
          resume_claim_expires_at?: string | null
          resume_claim_token?: string | null
          resume_claimed_at?: string | null
          routine_key: string
          routine_version?: number
          started_at?: string
          status?: string
          trigger?: string
          user_id: string
        }
        Update: {
          actual_cost_usd?: number | null
          approval_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          estimated_cost_usd?: number | null
          id?: string
          idempotency_key?: string | null
          input_snapshot?: Json
          output?: Json | null
          paused_step_key?: string | null
          resume_attempt?: number
          resume_claim_expires_at?: string | null
          resume_claim_token?: string | null
          resume_claimed_at?: string | null
          routine_key?: string
          routine_version?: number
          started_at?: string
          status?: string
          trigger?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routine_runs_approval_owner_fkey"
            columns: ["approval_id", "user_id"]
            isOneToOne: false
            referencedRelation: "approvals"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      routine_step_runs: {
        Row: {
          attempt: number
          completed_at: string | null
          created_at: string
          error: string | null
          id: string
          input_snapshot: Json | null
          ordinal: number
          output_snapshot: Json | null
          run_id: string
          started_at: string | null
          status: string
          step_key: string
          user_id: string
        }
        Insert: {
          attempt?: number
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          input_snapshot?: Json | null
          ordinal: number
          output_snapshot?: Json | null
          run_id: string
          started_at?: string | null
          status?: string
          step_key: string
          user_id: string
        }
        Update: {
          attempt?: number
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          input_snapshot?: Json | null
          ordinal?: number
          output_snapshot?: Json | null
          run_id?: string
          started_at?: string | null
          status?: string
          step_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routine_step_runs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "routine_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "routine_step_runs_run_owner_fkey"
            columns: ["run_id", "user_id"]
            isOneToOne: false
            referencedRelation: "routine_runs"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      routine_versions: {
        Row: {
          created_at: string
          definition: Json
          description: string
          id: string
          name: string
          routine_key: string
          routine_version: number
          source_version_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          definition?: Json
          description?: string
          id?: string
          name: string
          routine_key: string
          routine_version: number
          source_version_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          definition?: Json
          description?: string
          id?: string
          name?: string
          routine_key?: string
          routine_version?: number
          source_version_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      schedule_events: {
        Row: {
          all_day: boolean
          color_class: string
          created_at: string
          description: string | null
          end_at: string
          gcal_event_id: string | null
          id: string
          outlook_event_id: string | null
          recurrence_rule: string | null
          start_at: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          all_day?: boolean
          color_class?: string
          created_at?: string
          description?: string | null
          end_at: string
          gcal_event_id?: string | null
          id?: string
          outlook_event_id?: string | null
          recurrence_rule?: string | null
          start_at: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          all_day?: boolean
          color_class?: string
          created_at?: string
          description?: string | null
          end_at?: string
          gcal_event_id?: string | null
          id?: string
          outlook_event_id?: string | null
          recurrence_rule?: string | null
          start_at?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      signal_routes: {
        Row: {
          auto_route: boolean
          created_at: string
          destination: string
          enabled: boolean
          id: string
          label: string
          match_keyword: string | null
          match_source: string | null
          match_type: string | null
          metadata: Json
          set_priority: string
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_route?: boolean
          created_at?: string
          destination?: string
          enabled?: boolean
          id?: string
          label: string
          match_keyword?: string | null
          match_source?: string | null
          match_type?: string | null
          metadata?: Json
          set_priority?: string
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_route?: boolean
          created_at?: string
          destination?: string
          enabled?: boolean
          id?: string
          label?: string
          match_keyword?: string | null
          match_source?: string | null
          match_type?: string | null
          metadata?: Json
          set_priority?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      signals: {
        Row: {
          body: string | null
          created_at: string
          id: string
          metadata: Json
          read_at: string | null
          route_target: string | null
          routed_at: string | null
          signal_type: string
          source: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          read_at?: string | null
          route_target?: string | null
          routed_at?: string | null
          signal_type?: string
          source?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          read_at?: string | null
          route_target?: string | null
          routed_at?: string | null
          signal_type?: string
          source?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      studies: {
        Row: {
          created_at: string
          id: string
          meta: string
          next_action: string
          role: string
          sort_order: number
          stage_id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          meta?: string
          next_action?: string
          role?: string
          sort_order?: number
          stage_id: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          meta?: string
          next_action?: string
          role?: string
          sort_order?: number
          stage_id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "studies_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
        ]
      }
      supper_club_prefs: {
        Row: {
          custom_recipes: Json
          diet: string
          saved_ids: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          custom_recipes?: Json
          diet?: string
          saved_ids?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          custom_recipes?: Json
          diet?: string
          saved_ids?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          category: string
          completed_at: string | null
          created_at: string
          deadline: string | null
          effort: string | null
          id: string
          metadata: Json
          priority: string
          sort_order: number
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string
          completed_at?: string | null
          created_at?: string
          deadline?: string | null
          effort?: string | null
          id?: string
          metadata?: Json
          priority?: string
          sort_order?: number
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          completed_at?: string | null
          created_at?: string
          deadline?: string | null
          effort?: string | null
          id?: string
          metadata?: Json
          priority?: string
          sort_order?: number
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      training_sessions: {
        Row: {
          completed: boolean
          created_at: string
          dow: number
          duration_min: number
          id: string
          intensity: string
          kind: string
          notes: string | null
          sort_order: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed?: boolean
          created_at?: string
          dow: number
          duration_min?: number
          id?: string
          intensity?: string
          kind?: string
          notes?: string | null
          sort_order?: number
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed?: boolean
          created_at?: string
          dow?: number
          duration_min?: number
          id?: string
          intensity?: string
          kind?: string
          notes?: string | null
          sort_order?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_auth_settings: {
        Row: {
          biometric_prompted: boolean
          created_at: string
          passkey_enabled: boolean
          recovery_email: string | null
          remember_me: boolean
          twofa_enabled: boolean
          twofa_method: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          biometric_prompted?: boolean
          created_at?: string
          passkey_enabled?: boolean
          recovery_email?: string | null
          remember_me?: boolean
          twofa_enabled?: boolean
          twofa_method?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          biometric_prompted?: boolean
          created_at?: string
          passkey_enabled?: boolean
          recovery_email?: string | null
          remember_me?: boolean
          twofa_enabled?: boolean
          twofa_method?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_passkeys: {
        Row: {
          backed_up: boolean | null
          counter: number
          created_at: string
          credential_id: string
          credential_public_key: string
          device_type: string | null
          id: string
          last_used_at: string | null
          name: string
          refresh_token_enc: string | null
          transports: string[] | null
          user_id: string
        }
        Insert: {
          backed_up?: boolean | null
          counter?: number
          created_at?: string
          credential_id: string
          credential_public_key: string
          device_type?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          refresh_token_enc?: string | null
          transports?: string[] | null
          user_id: string
        }
        Update: {
          backed_up?: boolean | null
          counter?: number
          created_at?: string
          credential_id?: string
          credential_public_key?: string
          device_type?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          refresh_token_enc?: string | null
          transports?: string[] | null
          user_id?: string
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          created_at: string
          debrief_reminder: Json | null
          interface_settings: Json
          morning_routine: Json
          nav_order: Json
          night_routine: Json
          night_routine_checks: Json
          permissions: Json
          routine_checks: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          debrief_reminder?: Json | null
          interface_settings?: Json
          morning_routine?: Json
          nav_order?: Json
          night_routine?: Json
          night_routine_checks?: Json
          permissions?: Json
          routine_checks?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          debrief_reminder?: Json | null
          interface_settings?: Json
          morning_routine?: Json
          nav_order?: Json
          night_routine?: Json
          night_routine_checks?: Json
          permissions?: Json
          routine_checks?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          key: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          user_id: string
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: []
      }
      user_strava_tokens: {
        Row: {
          access_token: string
          athlete_id: number | null
          athlete_name: string | null
          created_at: string
          expires_at: string
          id: string
          refresh_token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          athlete_id?: number | null
          athlete_name?: string | null
          created_at?: string
          expires_at: string
          id?: string
          refresh_token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          athlete_id?: number | null
          athlete_name?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          refresh_token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      webauthn_challenges: {
        Row: {
          approval_id: string | null
          challenge: string
          created_at: string
          email: string | null
          expires_at: string
          id: string
          type: string
          user_id: string | null
        }
        Insert: {
          approval_id?: string | null
          challenge: string
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          type: string
          user_id?: string | null
        }
        Update: {
          approval_id?: string | null
          challenge?: string
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          type?: string
          user_id?: string | null
        }
        Relationships: []
      }
      widget_cache: {
        Row: {
          cache_key: string
          error: Json | null
          expires_at: string | null
          fetched_at: string
          hint: string | null
          raw: Json
          status: string
          updated_at: string
          user_id: string
          value: string | null
          widget_id: string
        }
        Insert: {
          cache_key: string
          error?: Json | null
          expires_at?: string | null
          fetched_at?: string
          hint?: string | null
          raw?: Json
          status?: string
          updated_at?: string
          user_id: string
          value?: string | null
          widget_id: string
        }
        Update: {
          cache_key?: string
          error?: Json | null
          expires_at?: string | null
          fetched_at?: string
          hint?: string | null
          raw?: Json
          status?: string
          updated_at?: string
          user_id?: string
          value?: string | null
          widget_id?: string
        }
        Relationships: []
      }
      workout_logs: {
        Row: {
          id: string
          log: Json
          logged_at: string
          session_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          log?: Json
          logged_at?: string
          session_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          log?: Json
          logged_at?: string
          session_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workout_logs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "training_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_vector_event: {
        Args: {
          p_client_revision: number
          p_device_id: string
          p_event_kind: string
          p_game_id: string
          p_idempotency_key: string
          p_occurred_at: string
          p_payload: Json
          p_payload_hash: string
          p_user_id: string
        }
        Returns: Json
      }
      axis_entity_ref_owned: {
        Args: { p_id: string; p_kind: string; p_user_id: string }
        Returns: boolean
      }
      cas_agent_task_transition: {
        Args: {
          p_completed_at?: string
          p_expected_status: string
          p_next_status: string
          p_task_id: string
          p_user_id: string
        }
        Returns: Json
      }
      cas_approval_transition: {
        Args: {
          p_approval_id: string
          p_decided_at?: string
          p_expected_status: string
          p_next_status: string
          p_user_id: string
        }
        Returns: Json
      }
      claim_routine_resume: {
        Args: {
          p_claim_token: string
          p_lease_seconds?: number
          p_run_id: string
          p_user_id: string
        }
        Returns: Json
      }
      cleanup_expired_challenges: { Args: never; Returns: number }
      cleanup_old_signals: { Args: never; Returns: number }
      commit_approval_step_up: {
        Args: {
          p_approval_id: string
          p_expected_approval_status: string
          p_expected_counter: number
          p_new_counter: number
          p_passkey_id: string
          p_user_id: string
          p_verified_at: string
        }
        Returns: Json
      }
      commit_passkey_authentication: {
        Args: {
          p_expected_counter: number
          p_expected_last_used_at: string
          p_new_counter: number
          p_passkey_id: string
          p_used_at: string
          p_user_id: string
        }
        Returns: Json
      }
      complete_claimed_routine_step: {
        Args: {
          p_claim_token: string
          p_output_snapshot: Json
          p_run_id: string
          p_step_run_id: string
          p_user_id: string
        }
        Returns: Json
      }
      complete_routine_resume: {
        Args: {
          p_actual_cost_usd?: number
          p_claim_token: string
          p_output: Json
          p_run_id: string
          p_status: string
          p_user_id: string
        }
        Returns: Json
      }
      consume_actionable_approval: {
        Args: { p_approval_id: string; p_now?: string; p_user_id: string }
        Returns: Json
      }
      consume_approval_authentication_challenge: {
        Args: {
          p_approval_id: string
          p_challenge_id: string
          p_now?: string
          p_user_id: string
        }
        Returns: Json
      }
      consume_webauthn_challenge: {
        Args: {
          p_challenge_id: string
          p_now?: string
          p_type: string
          p_user_id: string
        }
        Returns: Json
      }
      create_agent_task_with_activity: {
        Args: {
          p_activity_detail?: Json
          p_context?: Json
          p_objective: string
          p_source_routine_id?: string
          p_source_skill?: string
          p_user_id: string
        }
        Returns: Json
      }
      create_approval_with_activity: {
        Args: {
          p_action_class: string
          p_expires_at?: string
          p_proposed_action: Json
          p_reasons: string[]
          p_requirement: string
          p_scope?: string
          p_task_id: string
          p_user_id: string
        }
        Returns: Json
      }
      create_entity_reference: {
        Args: {
          p_label?: string
          p_relation?: string
          p_source_id: string
          p_source_kind: string
          p_target_id: string
          p_target_kind: string
        }
        Returns: string
      }
      create_idempotent_agent_task_with_activity: {
        Args: {
          p_activity_detail?: Json
          p_context?: Json
          p_idempotency_key?: string
          p_objective: string
          p_source_routine_id?: string
          p_source_skill?: string
          p_user_id: string
        }
        Returns: Json
      }
      create_user_passkey: {
        Args: {
          p_backed_up: boolean
          p_counter: number
          p_credential_id: string
          p_credential_public_key: string
          p_device_type: string
          p_name: string
          p_transports: string[]
          p_user_id: string
        }
        Returns: Json
      }
      delete_entity_reference: {
        Args: { p_reference_id: string }
        Returns: boolean
      }
      delete_user_passkey: {
        Args: { p_passkey_id: string; p_user_id: string }
        Returns: Json
      }
      expire_stale_approvals: { Args: never; Returns: number }
      fail_claimed_routine_step: {
        Args: {
          p_claim_token: string
          p_error_code: string
          p_run_id: string
          p_step_run_id: string
          p_user_id: string
        }
        Returns: Json
      }
      is_approval_scope_complete: {
        Args: {
          p_action_class: string
          p_created_at: string
          p_expires_at: string
          p_now: string
          p_proposed_action: Json
          p_reasons: string[]
          p_requirement: string
          p_scope: string
          p_user_id: string
        }
        Returns: boolean
      }
      mark_overdue_tasks: { Args: never; Returns: number }
      purge_old_done_tasks: { Args: never; Returns: undefined }
      record_entity_usage: {
        Args: { p_action: string; p_entity_id: string; p_entity_kind: string }
        Returns: {
          command_count: number
          created_at: string
          direct_open_count: number
          entity_id: string
          entity_kind: string
          last_action: string
          last_command_at: string | null
          last_direct_open_at: string | null
          last_link_at: string | null
          last_search_select_at: string | null
          last_used_at: string
          link_count: number
          search_select_count: number
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "entity_usage"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      release_routine_resume_claim: {
        Args: {
          p_claim_token: string
          p_error_code?: string
          p_run_id: string
          p_user_id: string
        }
        Returns: Json
      }
      renew_routine_resume_claim: {
        Args: {
          p_claim_token: string
          p_lease_seconds?: number
          p_run_id: string
          p_user_id: string
        }
        Returns: Json
      }
      repause_routine_resume: {
        Args: {
          p_approval_id: string
          p_claim_token: string
          p_idempotency_key: string
          p_run_id: string
          p_step_key: string
          p_user_id: string
        }
        Returns: Json
      }
      resolve_vector_conflict: {
        Args: {
          p_conflict_id: string
          p_expected_conflict_version: number
          p_idempotency_key: string
          p_payload_hash: string
          p_resolution: string
          p_target_slot_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      search_note_embeddings: {
        Args: { p_embedding: string; p_limit?: number }
        Returns: {
          note_id: string
          similarity: number
        }[]
      }
      start_claimed_routine_step: {
        Args: {
          p_claim_token: string
          p_input_snapshot?: Json
          p_ordinal: number
          p_run_id: string
          p_step_key: string
          p_user_id: string
        }
        Returns: Json
      }
      sync_vector_save: {
        Args: {
          p_checksum: string
          p_client_revision: number
          p_device_id: string
          p_expected_server_revision: number
          p_game_id: string
          p_game_version: string
          p_idempotency_key: string
          p_payload_hash: string
          p_save_schema_version: number
          p_seed: string
          p_slot_id: string
          p_state: Json
          p_updated_at: string
          p_user_id: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
