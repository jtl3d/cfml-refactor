<cfquery name="getThings" datasource="appdb">
    SELECT * FROM things WHERE id IN (
    <cfloop list="1,2,3" index="i">#i#,</cfloop>
    0)
</cfquery>
