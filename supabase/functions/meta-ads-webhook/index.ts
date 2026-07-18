import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const url = new URL(req.url);

    // Facebook webhook verification (GET request)
    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      const verifyToken = Deno.env.get('META_VERIFY_TOKEN');

      if (!verifyToken) {
        console.error('META_VERIFY_TOKEN is not configured');
        return new Response('Webhook verification is not configured', { status: 500 });
      }

      if (mode === 'subscribe' && token === verifyToken) {
        console.log('Meta webhook verified successfully');
        return new Response(challenge, { status: 200 });
      }
      return new Response('Verification failed', { status: 403 });
    }

    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await req.json();
    console.log('Received Meta Lead Ads webhook:', JSON.stringify(body));

    // Check for optional university_id in query params for routing
    const universityId = url.searchParams.get('university_id');

    const entries = body.entry || [];
    const leads: Record<string, any>[] = [];

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field === 'leadgen') {
          const leadData = change.value;

          // Try to fetch full lead data from Facebook Graph API
          const accessToken = Deno.env.get('META_ACCESS_TOKEN');
          if (accessToken && leadData.leadgen_id) {
            try {
              const leadResponse = await fetch(
                `https://graph.facebook.com/v18.0/${leadData.leadgen_id}?access_token=${accessToken}`
              );
              const fullLeadData = await leadResponse.json();
              const fieldData = fullLeadData.field_data || [];
              const parsedLead: Record<string, any> = {
                lead_source: 'Facebook Lead Ads',
                lead_medium: 'paid',
                lead_campaign: leadData.ad_name || leadData.campaign_name || 'Facebook Campaign',
              };

              for (const field of fieldData) {
                const name = field.name?.toLowerCase();
                const value = field.values?.[0];
                if (name?.includes('email')) parsedLead.email = value;
                else if (name?.includes('phone') || name?.includes('mobile')) parsedLead.mobile = value;
                else if (name?.includes('full_name') || (name?.includes('name') && !name.includes('last'))) parsedLead.name = value;
                else if (name?.includes('city')) parsedLead.city = value;
                else if (name?.includes('state')) parsedLead.state = value;
                else if (name?.includes('course') || name?.includes('program')) parsedLead.course = value;
                else parsedLead[name] = value;
              }
              leads.push(parsedLead);
            } catch (fetchError) {
              console.error('Error fetching lead details from Facebook:', fetchError);
              leads.push({
                name: 'Facebook Lead',
                lead_source: 'Facebook Lead Ads',
                lead_medium: 'paid',
                raw_data: leadData,
              });
            }
          } else {
            // Store with raw data if no access token
            leads.push({
              name: 'Facebook Lead',
              lead_source: 'Facebook Lead Ads',
              lead_medium: 'paid',
              raw_data: leadData,
            });
          }
        }
      }
    }

    // Also support flat/direct lead format: { name, email, mobile, ... }
    if (entries.length === 0 && (body.name || body.email || body.mobile)) {
      leads.push({
        name: body.name || body.full_name || 'Facebook Lead',
        email: body.email,
        mobile: body.phone || body.mobile || body.phone_number,
        city: body.city,
        state: body.state,
        course: body.course || body.program,
        lead_source: body.source || 'Facebook Lead Ads',
        lead_medium: body.medium || 'paid',
        lead_campaign: body.campaign || body.campaign_name || 'Facebook Campaign',
      });
    }

    if (leads.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No leads to process' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // If university_id specified, process leads without persisting individual lead rows.
    if (universityId) {
      const { data: batch } = await supabase
        .from('upload_batches')
        .insert({
          university_id: universityId,
          file_name: `Facebook_Ads_${new Date().toISOString()}`,
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
          sourceLabel: 'Facebook Lead Ads',
          leadData: {
            name: lead.name || defaults.name || 'Facebook Lead',
            email: lead.email || defaults.email || '',
            mobile: lead.mobile || defaults.mobile || '',
            city: lead.city || defaults.city || '',
            state: lead.state || defaults.state || '',
            course: lead.course || defaults.course || '',
            leadSource: lead.lead_source || uni?.source || 'Facebook Lead Ads',
            leadMedium: lead.lead_medium || uni?.medium || 'paid',
            leadCampaign: lead.lead_campaign || uni?.campaign || 'Facebook Campaign',
          },
          apiConfig: {
            apiUrl: uni?.api_url || '',
            secretKey: uni?.secret_key || '',
            collegeId: uni?.college_id || '',
            source: uni?.source || 'Facebook Lead Ads',
            medium: uni?.medium || 'paid',
            campaign: uni?.campaign || 'Facebook Campaign',
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
    console.error('Meta webhook error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
