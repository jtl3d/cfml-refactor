<cfquery name="keepMe" datasource="appdb">
    SELECT 1
</cfquery>

<!--- @cfml-refactor:skip --->
<cfquery name="ignoreMe" datasource="appdb">
    SELECT 2
</cfquery>

<cfquery name="alsoKeep" datasource="appdb">
    SELECT 3
</cfquery>
