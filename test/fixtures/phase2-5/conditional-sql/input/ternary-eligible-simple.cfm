<cfquery name="getThings" datasource="appdb">
    SELECT id, name FROM things
    WHERE category = 'a'
    <cfif includeArchived>
        AND archived = 1
    <cfelse>
        AND archived = 0
    </cfif>
</cfquery>
