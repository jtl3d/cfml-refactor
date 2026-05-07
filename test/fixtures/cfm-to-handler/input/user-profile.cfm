<cfparam name="url.id" default="0">

<!--- Look up the user and bail if missing --->
<cfset variables.userId = url.id>
<cfset variables.title = "User Profile">

<cfquery name="getUser" datasource="appdb">
    SELECT id, name, email, dept_id
    FROM users
    WHERE id = <cfqueryparam value="#variables.userId#" cfsqltype="cf_sql_integer">
</cfquery>

<cfif getUser.recordcount EQ 0>
    <cflocation url="/notfound.cfm">
</cfif>

<cfquery name="getDept" datasource="appdb">
    SELECT name AS deptName
    FROM departments
    WHERE id = <cfqueryparam value="#getUser.dept_id#" cfsqltype="cf_sql_integer">
</cfquery>

<cfset variables.greeting = "Hello, " & getUser.name>

<!DOCTYPE html>
<html>
<head><title><cfoutput>#variables.title#</cfoutput></title></head>
<body>
    <h1><cfoutput>#variables.greeting#</cfoutput></h1>
    <cfoutput>
        <p>Email: #getUser.email#</p>
        <p>Department: #getDept.deptName#</p>
    </cfoutput>
</body>
</html>
