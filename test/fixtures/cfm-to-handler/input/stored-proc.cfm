<cfset variables.userId = url.id>

<cfstoredproc procedure="GetUserDetails" datasource="appdb" returncode="yes" result="spResult">
    <cfprocparam type="in" cfsqltype="cf_sql_integer" value="#variables.userId#">
    <cfprocparam type="out" cfsqltype="cf_sql_varchar" variable="userName">
    <cfprocresult name="userRows" resultset="1">
</cfstoredproc>

<cfoutput>
    <p>Name: #userName#</p>
    <p>Rows: #userRows.recordcount#</p>
</cfoutput>
