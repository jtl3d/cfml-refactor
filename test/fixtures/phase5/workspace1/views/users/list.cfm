<cfsetting enablecfoutputonly="true">

<cfquery name="prc.users" datasource="appdb">
    SELECT id, name
    FROM users
    WHERE dept_id = <cfqueryparam name="deptId" value="#url.dept#" cfsqltype="cf_sql_integer">
</cfquery>

<cfquery name="prc.permissions" datasource="appdb">
    SELECT permission_id, name
    FROM permissions
    WHERE user_id = <cfqueryparam value="#url.userId#" cfsqltype="cf_sql_integer">
</cfquery>

<cfquery name="prc.recentLogins" datasource="appdb">
    SELECT login_at, ip_address
    FROM login_log
    WHERE user_id = <cfqueryparam value="#url.userId#" cfsqltype="cf_sql_integer">
    ORDER BY login_at DESC
</cfquery>

<cfquery name="prc.loginCounts" datasource="appdb">
    SELECT login_at, ip_address, COUNT(*) AS total
    FROM login_log
    WHERE ip_address = <cfqueryparam value="1.2.3.4" cfsqltype="cf_sql_varchar">
</cfquery>
