<cfset Variables.foo = url.id>
<cfset variables.bar = "hello">
<cfset VARIABLES.baz = 1>

<cfif Variables.foo EQ 0>
    <cfset variables.bar = "zero">
</cfif>

<cfoutput>
    <p>foo: #Variables.foo#</p>
    <p>bar: #variables.bar#</p>
    <p>baz: #VARIABLES.baz#</p>
</cfoutput>
