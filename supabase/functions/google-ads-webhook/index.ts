import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const url = new URL(req.url);
    const universityId = url.searchParams.get('university_id');
    const body = await req.json();
    console.log('Received Google Ads webhook:', JSON.stringify(body));

    const leads: Record<string, any>[] = [];

    // Native Google Ads Lead Form Extension format
    if (body.leadFormSubmission) {
      const submission = body.leadFormSubmission;
      const lead: Record<string, any> = {
        lead_source: 'Google Lead Ads',
        lead_medium: 'paid',
        lead_campaign: submission.campaignName || body.campaignName || 'Google Campaign',
      };

      const userColumns = submission.userData?.userColumnData || [];
      for (const column of userColumns) {
        const name = column.columnName?.toLowerCase();
        const value = column.stringValue;
        if (name?.includes('email')) lead.email = value;
        else if (name?.includes('phone')) lead.mobile = value;
        else if (name?.includes('name')) lead.name = value;
        else if (name?.includes('city')) lead.city = value;
        else if (name?.includes('state')) lead.state = value;
        else if (name?.includes('course') || name?.includes('program')) lead.course = value;
        else lead[name] = value;
      }
      leads.push(lead);
    } else if (body.entries || body.leads) {
      // Zapier/webhook aggregator format
      const entries = body.entries || body.leads || [body];
      for (const entry of entries) {
        leads.push({
          name: entry.name || entry.full_name || entry.first_name || 'Google Lead',
          email: entry.email || entry.email_address,
          mobile: entry.phone || entry.mobile || entry.phone_number,
          lead_source: 'Google Lead Ads',
          lead_medium: 'paid',
          lead_campaign: entry.campaign_name || entry.campaign || 'Google Campaign',
          city: entry.city,
          state: entry.state,
          course: entry.course || entry.program || entry.interest,
        });
      }
    } else {
      // Flat JSON format
      leads.push({
        name: body.name || body.full_name || body.first_name || 'Google Lead',
        email: body.email || body.email_address,
        mobile: body.phone || body.mobile || body.phone_number,
        lead_source: body.source || 'Google Lead Ads',
        lead_medium: body.medium || 'paid',
        lead_campaign: body.campaign_name || body.campaign || 'Google Campaign',
        city: body.city,
        state: body.state,
        course: body.course || body.program,
      });
    }

    // Process webhook leads without persisting individual lead rows.
    if (universityId && leads.length > 0) {
      const { data: batch } = await supabase
        .from('upload_batches')
        .insert({
          university_id: universityId,
          file_name: `Google_Ads_${new Date().toISOString()}`,
          total_leads: leads.length,
          status: 'processing',
          is_paused: false,
          is_cancelled: false,
          processed_count: 0,
          current_lead_index: 0,
        })
        .select('id')
        .single();

      if (batch) {
        const { data: uni } = await supabase
          .from('universities')
          .select('api_url, secret_key, college_id, source, medium, campaign, api_type, column_mapping, custom_headers, auth_type, auth_header_key, auth_header_value, payload_wrapper, default_values, api_timeout_seconds')
          .eq('id', universityId)
          .single();

        const defaults = (uni?.default_values as Record<string, string>) || {};
        const tasks = leads.map((lead) => ({
          universityId,
          batchId: batch.id,
          sourceLabel: 'Google Lead Ads',
          leadData: {
            name: lead.name || defaults.name || 'Google Lead',
            email: lead.email || defaults.email || '',
            mobile: lead.mobile || defaults.mobile || '',
            city: lead.city || defaults.city || '',
            state: lead.state || defaults.state || '',
            course: lead.course || defaults.course || '',
            leadSource: lead.lead_source || uni?.source || 'Google Lead Ads',
            leadMedium: lead.lead_medium || uni?.medium || 'paid',
            leadCampaign: lead.lead_campaign || uni?.campaign || 'Google Campaign',
          },
          apiConfig: {
            apiUrl: uni?.api_url || '',
            secretKey: uni?.secret_key || '',
            collegeId: uni?.college_id || '',
            source: uni?.source || 'Google Lead Ads',
            medium: uni?.medium || 'paid',
            campaign: uni?.campaign || 'Google Campaign',
            apiType: uni?.api_type || 'nopaperforms',
            columnMapping: uni?.column_mapping || {},
            customHeaders: uni?.custom_headers || {},
            authType: uni?.auth_type,
            authHeaderKey: uni?.auth_header_key,
            authHeaderValue: uni?.auth_header_value,
            payloadWrapper: uni?.payload_wrapper,
            universityDefaults: defaults,
            apiTimeoutSeconds: uni?.api_timeout_seconds,
          },
        }));
        await supabase.functions.invoke('process-lead', {
          body: { tasks, concurrency: 1 },
        });
        await supabase
          .from('upload_batches')
          .update({ status: 'completed', completed_at: new Date().toISOString(), processed_count: leads.length, current_lead_index: leads.length })
          .eq('id', batch.id);
      }
    }

    return new Response(
      JSON.stringify({ success: true, leads_received: leads.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Google webhook error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
